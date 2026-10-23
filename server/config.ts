import * as dotenv from "dotenv";

// ENV_FILE lets production settings live in their own file rather than
// overwriting the working local .env:
//
//   ENV_FILE=.env.base npm start
//
dotenv.config({ path: process.env.ENV_FILE || ".env" });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const CONFIG = {
  PORT: Number(process.env.PORT ?? 8787),
  RPC_URL: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  CHAIN_ID: Number(process.env.CHAIN_ID ?? 31337),
  DAILYTAP_ADDR: required("DAILYTAP_ADDR"),
  VERIFIER_PK: required("VERIFIER_PK"),

  /**
   * SIWE requires the domain inside the signed message to match what the
   * server expects. Pin it with an env var rather than reading req.hostname —
   * behind a proxy, req.hostname drifts and you get intermittent 401s that are
   * miserable to debug.
   */
  /**
   * Hosts accepted in the `domain` field of a SIWE message. Comma-separated,
   * because a site is usually reachable at both the apex and www and the
   * signed message carries whichever host the browser was on. A single value
   * means the other host fails sign-in with what looks like a signature error.
   * Still an allowlist — an unlisted host is rejected.
   */
  SIWE_DOMAINS: (process.env.SIWE_DOMAIN ?? "localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Unset means in-process state: fine for local dev, wrong the moment there
   * is more than one instance. Set it for anything deployed.
   * e.g. redis://127.0.0.1:6379 locally, rediss://… for a managed Redis.
   */
  REDIS_URL: process.env.REDIS_URL || undefined,
};

// --- Game constants ---------------------------------------------------------

/** The tap round the player actually plays. */
export const SCORING_WINDOW_MS = 5_000;

/**
 * A round must take at least this long. Below this the client is reporting a
 * window it did not actually play.
 */
export const MIN_ELAPSED_MS = 4_000;

/**
 * There is deliberately NO maximum elapsed time. Clamping the scoring window
 * below already means a slow client earns no larger ceiling than a fast one,
 * so a long elapsed buys an attacker nothing — while rejecting it would punish
 * every honest player who reads the screen, waits for a countdown, or has
 * their mobile browser suspend the tab. Sessions expire for memory hygiene
 * only, and generously.
 */
export const SESSION_TTL_MS = 10 * 60_000;

export const NONCE_TTL_MS = 5 * 60_000;

/**
 * How long a sign-in lasts. This token proves address control for convenience;
 * it can never authorize a transaction, and the verifier signature it unlocks
 * is still bound to msg.sender on chain. A leaked token costs the owner their
 * daily round and some duels — it is not custodial.
 */
export const TOKEN_TTL_MS = 24 * 60 * 60_000;

/** An unplayed duel goes stale rather than stranding whoever did show up. */
export const DUEL_TTL_MS = 24 * 60 * 60_000;

/** Duels a player may start or join per UTC day. */
export const MAX_DUELS_PER_DAY = 5;

/** Fastest a human sustains. Sets the plausibility ceiling at 65 per round. */
export const MAX_TAPS_PER_SEC = 13;

/**
 * Denominator for the performance multiplier. 35 taps in 5s (7/sec) is a
 * decent run, so a typical player sits near 1.0x and a strong run reaches
 * ~1.85x. Replace with a trailing 7-day average once there are real sessions
 * to average — the contract's MAX_PERF guard exists for exactly that day.
 */
export const REF_AVG = 35n;

/**
 * Sessions a wallet may open per UTC day. The on-chain `lastDay` mapping is
 * the real one-tap-per-day gate; this exists so an abandoned session does not
 * forfeit the day, without turning the game into best-of-fifty.
 *
 * Known limitation: this counter is in memory, so a server restart resets it.
 * Move it to Redis alongside the session store before this matters.
 */
export const MAX_ATTEMPTS_PER_DAY = 3;
