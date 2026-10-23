import assert from "node:assert/strict";
import { MemoryStore } from "../server/store/memory";
import { RedisStore } from "../server/store/redis";
import { Store, Round, Duel } from "../server/store/types";

/**
 * ONE suite, BOTH implementations.
 *
 * This is the whole point of the storage seam. The memory store gets
 * atomicity for free because JavaScript is single threaded; the Redis store
 * has to earn it with GETDEL, Lua and a lock. Running identical tests against
 * both is the only way to know they actually behave the same — and it already
 * caught a real one: the Redis store was writing losses to a field called
 * "losss".
 *
 * REDIS_TEST_URL is optional. Without it the Redis cases are skipped loudly
 * rather than silently passing.
 */

const REDIS_URL = process.env.REDIS_TEST_URL;

const round = (over: Partial<Round> = {}): Round => ({
  id: "r1", player: "0xAAA", purpose: "daily", day: 20747,
  startedAt: Date.now(), completed: false, ...over,
});

const duel = (over: Partial<Duel> = {}): Duel => ({
  id: "d1", code: "ABC123", day: 20747, createdAt: Date.now(),
  challenger: { player: "0xAAA", score: null, playedAt: null },
  opponent: null, status: "open", winner: null, ...over,
});

const MIN = 60_000;

function suite(name: string, make: () => Store) {
  describe(name, () => {
    let store: Store;

    before(async () => { store = make(); await store.connect(); });
    after(async () => { await store.flushAll(); await store.close(); });
    beforeEach(async () => { await store.flushAll(); });

    describe("nonces", () => {
      it("consumes exactly once", async () => {
        await store.putNonce("n1", MIN);
        assert.equal(await store.consumeNonce("n1"), true);
        assert.equal(await store.consumeNonce("n1"), false);
      });

      it("rejects an unknown nonce", async () => {
        assert.equal(await store.consumeNonce("never-existed"), false);
      });

      it("only one of many concurrent consumers wins", async () => {
        await store.putNonce("race", MIN);
        const results = await Promise.all(
          Array.from({ length: 20 }, () => store.consumeNonce("race"))
        );
        assert.equal(results.filter(Boolean).length, 1, "exactly one must win");
      });

      it("expires", async () => {
        await store.putNonce("quick", 20);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(await store.consumeNonce("quick"), false);
      });
    });

    describe("tokens", () => {
      it("resolves to the player, then forgets on delete", async () => {
        await store.putToken("t1", "0xBBB", MIN);
        assert.equal(await store.resolveToken("t1"), "0xBBB");
        await store.deleteToken("t1");
        assert.equal(await store.resolveToken("t1"), null);
      });

      it("returns null for a forged token", async () => {
        assert.equal(await store.resolveToken("0xdeadbeef"), null);
      });

      it("expires", async () => {
        await store.putToken("t2", "0xCCC", 20);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(await store.resolveToken("t2"), null);
      });
    });

    describe("rounds", () => {
      it("stores and reads back", async () => {
        await store.putRound(round(), MIN);
        const got = await store.getRound("r1");
        assert.equal(got?.player, "0xAAA");
        assert.equal(got?.completed, false);
      });

      it("claims exactly once", async () => {
        await store.putRound(round(), MIN);
        const first = await store.claimRound("r1");
        assert.ok(first, "first claim should succeed");
        assert.equal(first!.completed, true);
        assert.equal(await store.claimRound("r1"), null, "second claim must fail");
      });

      it("only one of many concurrent claims wins", async () => {
        await store.putRound(round(), MIN);
        const results = await Promise.all(
          Array.from({ length: 20 }, () => store.claimRound("r1"))
        );
        assert.equal(
          results.filter(Boolean).length, 1,
          "two signatures for one round would be a double mint"
        );
      });

      it("claiming a missing round returns null", async () => {
        assert.equal(await store.claimRound("nope"), null);
      });

      it("persists the completed flag for later reads", async () => {
        await store.putRound(round(), MIN);
        await store.claimRound("r1");
        assert.equal((await store.getRound("r1"))?.completed, true);
      });
    });

    describe("quotas", () => {
      it("allows up to the limit and then refuses", async () => {
        for (let i = 1; i <= 3; i++) {
          const r = await store.takeQuota("q", 3, MIN);
          assert.deepEqual(r, { allowed: true, used: i });
        }
        const over = await store.takeQuota("q", 3, MIN);
        assert.equal(over.allowed, false);
        assert.equal(over.used, 3);
      });

      it("does not overshoot under concurrency", async () => {
        const results = await Promise.all(
          Array.from({ length: 30 }, () => store.takeQuota("burst", 5, MIN))
        );
        assert.equal(results.filter((r) => r.allowed).length, 5);
        assert.equal(await store.readQuota("burst"), 5);
      });

      it("reading does not consume", async () => {
        await store.takeQuota("peek", 2, MIN);
        assert.equal(await store.readQuota("peek"), 1);
        assert.equal(await store.readQuota("peek"), 1);
      });
    });

    describe("duels", () => {
      it("reserves a code exactly once", async () => {
        assert.equal(await store.reserveCode("ABC123", "d1", MIN), true);
        assert.equal(await store.reserveCode("ABC123", "d2", MIN), false);
      });

      it("looks up by code, case-insensitively", async () => {
        await store.putDuel(duel(), MIN);
        await store.reserveCode("ABC123", "d1", MIN);
        assert.equal((await store.getDuelByCode("abc123"))?.id, "d1");
      });

      it("a retired code stops resolving", async () => {
        await store.putDuel(duel(), MIN);
        await store.reserveCode("ABC123", "d1", MIN);
        await store.retireCode("ABC123");
        assert.equal(await store.getDuelByCode("ABC123"), null);
      });

      it("mutates under a lock and persists the change", async () => {
        await store.putDuel(duel(), MIN);
        const out = await store.mutateDuel("d1", (d) => {
          d.opponent = { player: "0xBBB", score: null, playedAt: null };
          d.status = "awaiting";
          return "joined";
        }, MIN);
        assert.equal(out, "joined");
        const after = await store.getDuel("d1");
        assert.equal(after?.status, "awaiting");
        assert.equal(after?.opponent?.player, "0xBBB");
      });

      it("returning undefined aborts without writing", async () => {
        await store.putDuel(duel(), MIN);
        const out = await store.mutateDuel("d1", (d) => {
          d.status = "settled"; // should be discarded
          return undefined;
        }, MIN);
        assert.equal(out, undefined);
        assert.equal((await store.getDuel("d1"))?.status, "open");
      });

      it("concurrent mutations do not lose writes", async () => {
        await store.putDuel(duel({ challenger: { player: "0xAAA", score: 0, playedAt: null } }), MIN);
        // Ten increments that each read-modify-write. Without a lock the
        // classic outcome is a final value well below ten.
        await Promise.all(
          Array.from({ length: 10 }, () =>
            store.mutateDuel("d1", (d) => {
              d.challenger.score = (d.challenger.score ?? 0) + 1;
              return true;
            }, MIN)
          )
        );
        assert.equal((await store.getDuel("d1"))?.challenger.score, 10);
      });

      it("mutating a missing duel returns undefined", async () => {
        assert.equal(await store.mutateDuel("ghost", () => true, MIN), undefined);
      });

      it("lists live duels", async () => {
        await store.putDuel(duel({ id: "d1", code: "AAA111" }), MIN);
        await store.putDuel(duel({ id: "d2", code: "BBB222" }), MIN);
        const all = await store.listDuels();
        assert.deepEqual(all.map((d) => d.id).sort(), ["d1", "d2"]);
      });

      it("hands out copies, not live references", async () => {
        await store.putDuel(duel(), MIN);
        const a = await store.getDuel("d1");
        a!.status = "settled";
        assert.equal((await store.getDuel("d1"))?.status, "open");
      });
    });

    describe("leaderboard", () => {
      it("starts everyone at zero", async () => {
        const s = await store.standing("0xNEW");
        assert.deepEqual(s, {
          player: "0xNEW", points: 0, wins: 0, losses: 0, draws: 0, played: 0,
        });
      });

      it("records each outcome in the right column", async () => {
        await store.recordOutcome("0xAAA", "win", 3);
        await store.recordOutcome("0xAAA", "loss", 1);
        await store.recordOutcome("0xAAA", "draw", 2);
        await store.recordOutcome("0xAAA", "walkover", 2);
        const s = await store.standing("0xAAA");
        assert.equal(s.points, 8);
        assert.equal(s.wins, 1);
        assert.equal(s.losses, 1, "a loss must land in losses");
        assert.equal(s.draws, 1);
        assert.equal(s.played, 4, "a walkover counts as played");
      });

      it("sorts the top table by points", async () => {
        await store.recordOutcome("0xLOW", "loss", 1);
        await store.recordOutcome("0xHIGH", "win", 3);
        await store.recordOutcome("0xMID", "draw", 2);
        const top = await store.topStandings(10);
        assert.deepEqual(top.map((s) => s.player), ["0xHIGH", "0xMID", "0xLOW"]);
      });

      it("honours the limit", async () => {
        for (let i = 0; i < 5; i++) await store.recordOutcome(`0x${i}`, "win", i + 1);
        assert.equal((await store.topStandings(2)).length, 2);
      });

      it("accumulates across many results", async () => {
        for (let i = 0; i < 10; i++) await store.recordOutcome("0xGRIND", "win", 3);
        const s = await store.standing("0xGRIND");
        assert.equal(s.points, 30);
        assert.equal(s.wins, 10);
      });
    });
  });
}

suite("MemoryStore", () => new MemoryStore());

if (REDIS_URL) {
  suite("RedisStore", () => new RedisStore(REDIS_URL));
} else {
  describe("RedisStore", () => {
    it("SKIPPED — set REDIS_TEST_URL to run these", function () {
      this.skip();
    });
  });
}
