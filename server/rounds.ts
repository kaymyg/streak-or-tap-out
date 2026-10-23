import { ethers } from "ethers";
import {
  SCORING_WINDOW_MS,
  MIN_ELAPSED_MS,
  SESSION_TTL_MS,
  MAX_TAPS_PER_SEC,
} from "./config";
import { store } from "./db";
import { Round, RoundPurpose } from "./store";

export { SESSION_TTL_MS };

/**
 * A round is five seconds of tapping, opened and closed by the server. Daily
 * taps and duels both use it, deliberately: there is exactly one place in the
 * codebase that decides whether a reported score is humanly possible, so the
 * two modes cannot drift apart.
 */

export async function openRound(
  player: string,
  purpose: RoundPurpose,
  day: number,
  duelId?: string
): Promise<Round> {
  const round: Round = {
    id: ethers.hexlify(ethers.randomBytes(16)),
    player,
    purpose,
    day,
    duelId,
    startedAt: Date.now(),
    completed: false,
  };
  await store.putRound(round, SESSION_TTL_MS);
  return round;
}

export type Plausibility =
  | { ok: true; tapCount: number; elapsed: number }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * The entire anti-cheat layer.
 *
 * It does not prove anyone tapped. A scripted client that waits the real five
 * seconds and reports a humanly-possible number still passes, and no server
 * logic changes that — a client-side score cannot be verified. What this does
 * is make cheating cost more effort than a day's reward is worth, which is the
 * argument for keeping BASE_REWARD small.
 *
 * Pure on purpose: no I/O, no store, no clock beyond Date.now(), so it is
 * trivial to reason about and to test.
 */
export function checkPlausible(round: Round, tapCount: unknown): Plausibility {
  if (!Number.isInteger(tapCount)) {
    return { ok: false, status: 400, body: { error: "tapCount must be an integer" } };
  }
  const n = tapCount as number;

  const elapsed = Date.now() - round.startedAt;
  if (elapsed < MIN_ELAPSED_MS) {
    return { ok: false, status: 400, body: { error: "round too short", elapsed } };
  }

  // Clamp the scoring window from above so a slow client never earns a larger
  // ceiling than a fast one. There is no maximum elapsed time: clamping here
  // means a long round buys an attacker nothing, while rejecting it would
  // punish anyone whose phone suspended the tab.
  const windowMs = Math.min(elapsed, SCORING_WINDOW_MS);
  const maxTaps = Math.floor((windowMs / 1000) * MAX_TAPS_PER_SEC);

  if (n < 1 || n > maxTaps) {
    return {
      ok: false,
      status: 400,
      body: { error: "implausible tap count", tapCount: n, maxTaps },
    };
  }

  return { ok: true, tapCount: n, elapsed };
}
