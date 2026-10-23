import Redis from "ioredis";
import {
  Store, Round, Duel, Standing, Outcome, emptyStanding,
} from "./types";

/**
 * Redis-backed store.
 *
 * The interesting parts are the operations that have to be atomic. In the
 * memory store they are free — JavaScript is single threaded. Here they are
 * not, and getting them wrong produces bugs that only appear under
 * concurrency, which is to say only in production:
 *
 *   consumeNonce  -> GETDEL, so a replayed SIWE message loses the race
 *   claimRound    -> Lua compare-and-set, so one signature per round
 *   takeQuota     -> Lua check-and-increment, so caps cannot overshoot
 *   mutateDuel    -> a short lock, because join and score submission are both
 *                    read-modify-write and two players finishing together is
 *                    the normal case
 *
 * Everything carries a TTL. Redis expires keys itself, so sweep() is a no-op
 * here — the opposite of the memory store, which is why the shared test suite
 * checks expiry behaviour rather than the mechanism.
 */

const P = {
  nonce: (n: string) => `nonce:${n}`,
  token: (t: string) => `token:${t}`,
  round: (id: string) => `round:${id}`,
  quota: (k: string) => `quota:${k}`,
  duel: (id: string) => `duel:${id}`,
  code: (c: string) => `code:${c.toUpperCase()}`,
  lock: (id: string) => `lock:duel:${id}`,
  duelSet: "duels",
  points: "lb:points",
  record: (p: string) => `lb:rec:${p}`,
};

/** Mark a round completed only if it exists and is not already completed. */
const CLAIM_ROUND = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local round = cjson.decode(raw)
if round.completed then return nil end
round.completed = true
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then ttl = 60000 end
redis.call('SET', KEYS[1], cjson.encode(round), 'PX', ttl)
return cjson.encode(round)
`;

/** Increment only while below the limit; set the TTL on first use. */
const TAKE_QUOTA = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if used >= limit then return {0, used} end
local now = redis.call('INCR', KEYS[1])
if now == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return {1, now}
`;

/** Release a lock only if we still own it. */
const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RedisStore implements Store {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      // Upstash and most managed Redis require TLS; rediss:// turns it on.
    });
    this.redis.defineCommand("claimRound", { numberOfKeys: 1, lua: CLAIM_ROUND });
    this.redis.defineCommand("takeQuota", { numberOfKeys: 1, lua: TAKE_QUOTA });
    this.redis.defineCommand("unlock", { numberOfKeys: 1, lua: UNLOCK });
  }

  async connect() {
    await this.redis.connect();
  }

  async close() {
    await this.redis.quit();
  }

  // --- auth -----------------------------------------------------------------

  async putNonce(nonce: string, ttlMs: number) {
    await this.redis.set(P.nonce(nonce), "1", "PX", ttlMs);
  }

  async consumeNonce(nonce: string) {
    // GETDEL is one round trip and one operation — a GET followed by a DEL
    // would let two concurrent sign-ins both succeed with the same nonce.
    const v = await this.redis.getdel(P.nonce(nonce));
    return v !== null;
  }

  async putToken(token: string, player: string, ttlMs: number) {
    await this.redis.set(P.token(token), player, "PX", ttlMs);
  }

  async resolveToken(token: string) {
    return this.redis.get(P.token(token));
  }

  async deleteToken(token: string) {
    await this.redis.del(P.token(token));
  }

  // --- rounds ---------------------------------------------------------------

  async putRound(round: Round, ttlMs: number) {
    await this.redis.set(P.round(round.id), JSON.stringify(round), "PX", ttlMs);
  }

  async getRound(id: string) {
    const raw = await this.redis.get(P.round(id));
    return raw ? (JSON.parse(raw) as Round) : null;
  }

  async claimRound(id: string) {
    const raw = await (this.redis as any).claimRound(P.round(id));
    return raw ? (JSON.parse(raw) as Round) : null;
  }

  async deleteRound(id: string) {
    await this.redis.del(P.round(id));
  }

  // --- quotas ---------------------------------------------------------------

  async takeQuota(key: string, limit: number, ttlMs: number) {
    const [ok, used] = (await (this.redis as any).takeQuota(
      P.quota(key), String(limit), String(ttlMs)
    )) as [number, number];
    return { allowed: ok === 1, used };
  }

  async readQuota(key: string) {
    return Number((await this.redis.get(P.quota(key))) ?? 0);
  }

  // --- duels ----------------------------------------------------------------

  async putDuel(duel: Duel, ttlMs: number) {
    await this.redis
      .multi()
      .set(P.duel(duel.id), JSON.stringify(duel), "PX", ttlMs)
      .sadd(P.duelSet, duel.id)
      .exec();
  }

  async getDuel(id: string) {
    const raw = await this.redis.get(P.duel(id));
    return raw ? (JSON.parse(raw) as Duel) : null;
  }

  async getDuelByCode(code: string) {
    const id = await this.redis.get(P.code(code));
    return id ? this.getDuel(id) : null;
  }

  async reserveCode(code: string, duelId: string, ttlMs: number) {
    // NX makes this a real reservation rather than a check followed by a write.
    const ok = await this.redis.set(P.code(code), duelId, "PX", ttlMs, "NX");
    return ok === "OK";
  }

  async retireCode(code: string) {
    await this.redis.del(P.code(code));
  }

  async mutateDuel<T>(
    id: string,
    fn: (duel: Duel) => Promise<T | undefined> | T | undefined,
    ttlMs: number
  ) {
    const lockKey = P.lock(id);
    const fence = `${process.pid}-${Date.now()}-${Math.random()}`;

    // Spin briefly rather than failing. A duel mutation is a few milliseconds;
    // if we cannot get the lock in a second something is badly wrong and
    // throwing is more honest than silently dropping the write.
    let held = false;
    for (let i = 0; i < 50; i++) {
      if ((await this.redis.set(lockKey, fence, "PX", 3000, "NX")) === "OK") {
        held = true;
        break;
      }
      await sleep(20);
    }
    if (!held) throw new Error(`could not lock duel ${id}`);

    try {
      const duel = await this.getDuel(id);
      if (!duel) return undefined;
      const out = await fn(duel);
      if (out === undefined) return undefined;
      await this.putDuel(duel, ttlMs);
      return out;
    } finally {
      // Only release our own lock — if ours expired and someone else took it,
      // deleting blindly would free theirs.
      await (this.redis as any).unlock(lockKey, fence);
    }
  }

  async listDuels() {
    const ids = await this.redis.smembers(P.duelSet);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map(P.duel));
    const out: Duel[] = [];
    const gone: string[] = [];
    raws.forEach((raw, i) => {
      if (raw) out.push(JSON.parse(raw) as Duel);
      else gone.push(ids[i]); // expired out from under the index
    });
    if (gone.length) await this.redis.srem(P.duelSet, ...gone);
    return out;
  }

  // --- leaderboard -----------------------------------------------------------

  /**
   * An explicit map, not `${outcome}s` — that produced "losss" and silently
   * wrote every loss to a field nothing ever read. The memory store got it
   * right by using a switch, which is precisely the kind of divergence the
   * shared test suite exists to catch.
   */
  private static FIELD: Record<Outcome, string | null> = {
    win: "wins",
    loss: "losses",
    draw: "draws",
    walkover: null,
  };

  async recordOutcome(player: string, outcome: Outcome, points: number) {
    const field = RedisStore.FIELD[outcome];
    const m = this.redis.multi().zincrby(P.points, points, player);
    m.hincrby(P.record(player), "played", 1);
    if (field) m.hincrby(P.record(player), field, 1);
    await m.exec();
  }

  async standing(player: string) {
    const [score, rec] = await Promise.all([
      this.redis.zscore(P.points, player),
      this.redis.hgetall(P.record(player)),
    ]);
    if (score === null && Object.keys(rec).length === 0) return emptyStanding(player);
    return {
      player,
      points: Number(score ?? 0),
      wins: Number(rec.wins ?? 0),
      losses: Number(rec.losses ?? 0),
      draws: Number(rec.draws ?? 0),
      played: Number(rec.played ?? 0),
    };
  }

  async topStandings(n: number) {
    // A sorted set is the natural shape for a leaderboard: Redis keeps it
    // ordered on write, so reading the top N never scans the whole table.
    const flat = await this.redis.zrevrange(P.points, 0, n - 1, "WITHSCORES");
    const players: string[] = [];
    for (let i = 0; i < flat.length; i += 2) players.push(flat[i]);
    return Promise.all(players.map((p) => this.standing(p)));
  }

  // --- housekeeping ----------------------------------------------------------

  async sweep(_now: number) {
    // Redis expires keys itself. The duel index is tidied lazily in listDuels.
  }

  async flushAll() {
    await this.redis.flushdb();
  }
}
