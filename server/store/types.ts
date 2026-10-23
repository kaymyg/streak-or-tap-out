/**
 * The storage seam.
 *
 * Everything the server remembers between requests goes through this
 * interface. There are two implementations — a Map-backed one for local dev
 * and a Redis-backed one for anywhere real — and one test suite that runs
 * against both, so they cannot drift apart.
 *
 * Why this exists: the first version kept all of this in module-level Maps.
 * That is correct in exactly one situation — a single long-lived process — and
 * silently wrong everywhere else. On a serverless host or behind any load
 * balancer with two instances, a round opened on instance A is invisible to
 * instance B, and /round/end fails intermittently. That reads as flakiness
 * rather than an architecture mismatch, which is the worst kind of bug to
 * inherit.
 *
 * Note that every method is async even in the memory implementation. That is
 * deliberate: if the local path were synchronous, the Redis path would be the
 * only one exercising the await points, and the difference would show up as
 * race conditions that only appear in production.
 */

export type RoundPurpose = "daily" | "duel";

export type Round = {
  id: string;
  player: string;
  purpose: RoundPurpose;
  day: number;
  duelId?: string;
  startedAt: number;
  completed: boolean;
};

export type Side = { player: string; score: number | null; playedAt: number | null };

export type Duel = {
  id: string;
  code: string;
  day: number;
  createdAt: number;
  challenger: Side;
  opponent: Side | null;
  status: "open" | "awaiting" | "settled" | "expired";
  /** address, or null for a draw. Only meaningful once settled or expired. */
  winner: string | null;
};

export type Standing = {
  player: string;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  played: number;
};

export type Outcome = "win" | "loss" | "draw" | "walkover";

export interface Store {
  /** Called once at boot. */
  connect(): Promise<void>;
  close(): Promise<void>;

  // --- auth ---------------------------------------------------------------

  putNonce(nonce: string, ttlMs: number): Promise<void>;

  /**
   * Returns true exactly once per nonce, even if two requests race.
   * A read-then-delete pair here would let a replayed SIWE message through
   * under concurrency, so this has to be one atomic operation.
   */
  consumeNonce(nonce: string): Promise<boolean>;

  putToken(token: string, player: string, ttlMs: number): Promise<void>;
  /** The address this token belongs to, or null if unknown or expired. */
  resolveToken(token: string): Promise<string | null>;
  deleteToken(token: string): Promise<void>;

  // --- rounds -------------------------------------------------------------

  putRound(round: Round, ttlMs: number): Promise<void>;
  getRound(id: string): Promise<Round | null>;

  /**
   * Marks a round completed and returns it — but only for the first caller.
   * Subsequent callers get null. Without this, two concurrent /round/end
   * requests could both pass the `completed` check and both get a signature.
   */
  claimRound(id: string): Promise<Round | null>;

  deleteRound(id: string): Promise<void>;

  // --- quotas -------------------------------------------------------------

  /**
   * Increment a counter if it is below `limit`. Returns whether the caller
   * got a slot and how many are now used. Atomic for the same reason as
   * consumeNonce: a check-then-increment would let concurrent requests
   * overshoot the cap.
   */
  takeQuota(key: string, limit: number, ttlMs: number): Promise<{ allowed: boolean; used: number }>;

  /** Read-only; does not consume a slot. */
  readQuota(key: string): Promise<number>;

  // --- duels --------------------------------------------------------------

  putDuel(duel: Duel, ttlMs: number): Promise<void>;
  getDuel(id: string): Promise<Duel | null>;
  getDuelByCode(code: string): Promise<Duel | null>;
  /** Removes the code -> id index so a dead duel's code stops working. */
  retireCode(code: string): Promise<void>;
  /** Codes must be unique; returns false if this one is taken. */
  reserveCode(code: string, duelId: string, ttlMs: number): Promise<boolean>;

  /**
   * Read, mutate, write — with nobody else touching this duel in between.
   * Join and score submission are both read-modify-write, and two players
   * finishing at the same moment is the normal case, not the edge case.
   * Returning undefined from `fn` aborts without writing.
   */
  mutateDuel<T>(
    id: string,
    fn: (duel: Duel) => Promise<T | undefined> | T | undefined,
    ttlMs: number
  ): Promise<T | undefined>;

  listDuels(): Promise<Duel[]>;

  // --- leaderboard ---------------------------------------------------------

  recordOutcome(player: string, outcome: Outcome, points: number): Promise<void>;
  standing(player: string): Promise<Standing>;
  topStandings(n: number): Promise<Standing[]>;

  // --- housekeeping ---------------------------------------------------------

  /**
   * Redis expires keys itself; the memory store has to be swept. Called on a
   * timer either way so the two behave the same from the outside.
   */
  sweep(now: number): Promise<void>;

  /** Test seam. Never called by the server. */
  flushAll(): Promise<void>;
}

export const emptyStanding = (player: string): Standing => ({
  player,
  points: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  played: 0,
});
