import {
  Store, Round, Duel, Standing, Outcome, emptyStanding,
} from "./types";

type Expiring<T> = { value: T; expiresAt: number };

/**
 * In-process store for local development.
 *
 * JavaScript is single threaded and nothing here awaits mid-operation, so the
 * "atomic" methods are atomic for free. That is worth saying out loud, because
 * it is exactly why the Redis implementation needs real work to match this
 * one's behaviour — and why both are run against the same test suite.
 */
export class MemoryStore implements Store {
  private nonces = new Map<string, number>();
  private tokens = new Map<string, Expiring<string>>();
  private rounds = new Map<string, Expiring<Round>>();
  private quotas = new Map<string, Expiring<number>>();
  private duels = new Map<string, Expiring<Duel>>();
  private codes = new Map<string, Expiring<string>>();
  private board = new Map<string, Standing>();

  async connect() {}
  async close() {}

  private live<T>(m: Map<string, Expiring<T>>, k: string): T | null {
    const e = m.get(k);
    if (!e) return null;
    if (e.expiresAt < Date.now()) { m.delete(k); return null; }
    return e.value;
  }

  // --- auth -----------------------------------------------------------------

  async putNonce(nonce: string, ttlMs: number) {
    this.nonces.set(nonce, Date.now() + ttlMs);
  }

  async consumeNonce(nonce: string) {
    const exp = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    return exp !== undefined && exp >= Date.now();
  }

  async putToken(token: string, player: string, ttlMs: number) {
    this.tokens.set(token, { value: player, expiresAt: Date.now() + ttlMs });
  }

  async resolveToken(token: string) {
    return this.live(this.tokens, token);
  }

  async deleteToken(token: string) {
    this.tokens.delete(token);
  }

  // --- rounds ---------------------------------------------------------------

  async putRound(round: Round, ttlMs: number) {
    this.rounds.set(round.id, { value: round, expiresAt: Date.now() + ttlMs });
  }

  async getRound(id: string) {
    const r = this.live(this.rounds, id);
    return r ? { ...r } : null;
  }

  async claimRound(id: string) {
    const r = this.live(this.rounds, id);
    if (!r || r.completed) return null;
    r.completed = true;
    return { ...r };
  }

  async deleteRound(id: string) {
    this.rounds.delete(id);
  }

  // --- quotas ---------------------------------------------------------------

  async takeQuota(key: string, limit: number, ttlMs: number) {
    const used = this.live(this.quotas, key) ?? 0;
    if (used >= limit) return { allowed: false, used };
    this.quotas.set(key, { value: used + 1, expiresAt: Date.now() + ttlMs });
    return { allowed: true, used: used + 1 };
  }

  async readQuota(key: string) {
    return this.live(this.quotas, key) ?? 0;
  }

  // --- duels ----------------------------------------------------------------

  async putDuel(duel: Duel, ttlMs: number) {
    this.duels.set(duel.id, { value: duel, expiresAt: Date.now() + ttlMs });
  }

  async getDuel(id: string) {
    const d = this.live(this.duels, id);
    return d ? structuredClone(d) : null;
  }

  async getDuelByCode(code: string) {
    const id = this.live(this.codes, code.toUpperCase());
    return id ? this.getDuel(id) : null;
  }

  async reserveCode(code: string, duelId: string, ttlMs: number) {
    const key = code.toUpperCase();
    if (this.live(this.codes, key)) return false;
    this.codes.set(key, { value: duelId, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async retireCode(code: string) {
    this.codes.delete(code.toUpperCase());
  }

  /**
   * Serialized per duel id.
   *
   * The naive version — read, clone, `await fn`, write — looks atomic because
   * JavaScript is single threaded, but the await is a yield point: ten
   * concurrent callers all read the same value and all write back the same
   * increment, and nine updates vanish. The shared store test caught this
   * (Redis passed because it takes a lock), which is the entire argument for
   * running one suite against both implementations.
   *
   * Chaining onto the previous mutation for the same id is enough here, since
   * this store is by definition one process.
   */
  private chains = new Map<string, Promise<unknown>>();

  async mutateDuel<T>(
    id: string,
    fn: (duel: Duel) => Promise<T | undefined> | T | undefined,
    ttlMs: number
  ): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      const current = this.live(this.duels, id);
      if (!current) return undefined;
      const draft = structuredClone(current);
      const out = await fn(draft);
      if (out === undefined) return undefined;
      this.duels.set(id, { value: draft, expiresAt: Date.now() + ttlMs });
      return out;
    };

    const prior = this.chains.get(id) ?? Promise.resolve();
    // `catch` so one failed mutation does not poison every later one.
    const next = prior.catch(() => {}).then(run);
    this.chains.set(id, next);

    try {
      return await next;
    } finally {
      if (this.chains.get(id) === next) this.chains.delete(id);
    }
  }

  async listDuels() {
    const now = Date.now();
    return [...this.duels.values()]
      .filter((e) => e.expiresAt >= now)
      .map((e) => structuredClone(e.value));
  }

  // --- leaderboard -----------------------------------------------------------

  async recordOutcome(player: string, outcome: Outcome, points: number) {
    const s = this.board.get(player) ?? emptyStanding(player);
    s.points += points;
    s.played += 1;
    if (outcome === "win") s.wins += 1;
    else if (outcome === "loss") s.losses += 1;
    else if (outcome === "draw") s.draws += 1;
    this.board.set(player, s);
  }

  async standing(player: string) {
    return { ...(this.board.get(player) ?? emptyStanding(player)) };
  }

  async topStandings(n: number) {
    return [...this.board.values()]
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.player.localeCompare(b.player))
      .slice(0, n)
      .map((s) => ({ ...s }));
  }

  // --- housekeeping ----------------------------------------------------------

  async sweep(now: number) {
    for (const [k, exp] of this.nonces) if (exp < now) this.nonces.delete(k);
    for (const m of [this.tokens, this.rounds, this.quotas, this.duels, this.codes]) {
      for (const [k, e] of m as Map<string, Expiring<unknown>>) {
        if (e.expiresAt < now) m.delete(k);
      }
    }
  }

  async flushAll() {
    this.nonces.clear();
    this.tokens.clear();
    this.rounds.clear();
    this.quotas.clear();
    this.duels.clear();
    this.codes.clear();
    this.board.clear();
  }
}
