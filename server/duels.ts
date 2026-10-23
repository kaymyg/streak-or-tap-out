import { randomInt } from "crypto";
import { ethers } from "ethers";
import { DUEL_TTL_MS, MAX_DUELS_PER_DAY } from "./config";
import { store } from "./db";
import { Duel, Side, Outcome } from "./store";

/**
 * Points-only duels.
 *
 * Two players tap for five seconds each and the higher score wins season
 * points. There is no ante, no pot and no settlement — so this never touches
 * the chain, and there is nothing for a rake to take a cut of. That is the
 * property that keeps the feature outside wagering, and the one a refactor is
 * most likely to break, so e2e-duel.ts asserts it directly.
 *
 * Duels are asynchronous on purpose. The creator plays, shares a code, and the
 * opponent plays whenever they open the app. Realtime matchmaking needs
 * sockets and a presence model; this needs a key-value store.
 */

export const POINTS = { win: 3, draw: 2, loss: 1, walkover: 2 } as const;

export type Fail = { error: string; status: number };
const fail = (error: string, status: number): Fail => ({ error, status });

// No I, O, 0 or 1 — these get read aloud and typed in by hand.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  let c = "";
  for (let i = 0; i < 6; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}

export const quotaKey = (player: string, day: number) => `duels:${player}:${day}`;

export function duelsStartedToday(player: string, day: number) {
  return store.readQuota(quotaKey(player, day));
}

export async function create(player: string, day: number): Promise<Duel | Fail> {
  const quota = await store.takeQuota(quotaKey(player, day), MAX_DUELS_PER_DAY, DUEL_TTL_MS);
  if (!quota.allowed) return fail("duel limit reached for today", 429);

  const id = ethers.hexlify(ethers.randomBytes(12));

  // reserveCode is SET NX, so a collision loses the race rather than silently
  // overwriting someone else's duel.
  let code = "";
  for (let attempt = 0; attempt < 50 && !code; attempt++) {
    const candidate = randomCode();
    if (await store.reserveCode(candidate, id, DUEL_TTL_MS)) code = candidate;
  }
  if (!code) return fail("could not allocate a duel code", 503);

  const duel: Duel = {
    id,
    code,
    day,
    createdAt: Date.now(),
    challenger: { player, score: null, playedAt: null },
    opponent: null,
    status: "open",
    winner: null,
  };
  await store.putDuel(duel, DUEL_TTL_MS);
  return duel;
}

export async function join(player: string, code: string, day: number): Promise<Duel | Fail> {
  const found = await store.getDuelByCode(code.trim().toUpperCase());
  if (!found) return fail("no duel with that code", 404);

  const quota = await store.takeQuota(quotaKey(player, day), MAX_DUELS_PER_DAY, DUEL_TTL_MS);
  if (!quota.allowed) return fail("duel limit reached for today", 429);

  let err: Fail | null = null;
  const ok = await store.mutateDuel(found.id, (d) => {
    if (d.status !== "open") { err = fail("that duel is no longer open", 409); return undefined; }
    // Duelling yourself would farm points for free, and with the leaderboard
    // being the only prize that is the entire exploit surface here.
    if (d.challenger.player.toLowerCase() === player.toLowerCase()) {
      err = fail("you cannot duel yourself", 400);
      return undefined;
    }
    d.opponent = { player, score: null, playedAt: null };
    d.status = "awaiting";
    return true;
  }, DUEL_TTL_MS);

  if (err) return err;
  if (!ok) return fail("no duel with that code", 404);
  return (await store.getDuel(found.id))!;
}

export const get = (id: string) => store.getDuel(id);

export function sideFor(duel: Duel, player: string): Side | null {
  const p = player.toLowerCase();
  if (duel.challenger.player.toLowerCase() === p) return duel.challenger;
  if (duel.opponent && duel.opponent.player.toLowerCase() === p) return duel.opponent;
  return null;
}

export async function submitScore(
  duelId: string,
  player: string,
  score: number
): Promise<{ duel: Duel } | Fail> {
  let err: Fail | null = null;
  // Leaderboard writes happen AFTER the mutation, never inside it — holding a
  // duel lock while writing to another key is how you get a deadlock later.
  let awards: { player: string; outcome: Outcome; points: number }[] = [];

  const ok = await store.mutateDuel(duelId, (d) => {
    const side = sideFor(d, player);
    if (!side) { err = fail("you are not in this duel", 403); return undefined; }
    if (side.score !== null) { err = fail("you already played this duel", 409); return undefined; }
    if (d.status === "settled" || d.status === "expired") {
      err = fail("this duel is over", 409);
      return undefined;
    }

    side.score = score;
    side.playedAt = Date.now();

    if (d.opponent && d.challenger.score !== null && d.opponent.score !== null) {
      const a = d.challenger;
      const b = d.opponent;
      d.status = "settled";
      if (a.score! > b.score!) {
        d.winner = a.player;
        awards = [
          { player: a.player, outcome: "win", points: POINTS.win },
          { player: b.player, outcome: "loss", points: POINTS.loss },
        ];
      } else if (b.score! > a.score!) {
        d.winner = b.player;
        awards = [
          { player: b.player, outcome: "win", points: POINTS.win },
          { player: a.player, outcome: "loss", points: POINTS.loss },
        ];
      } else {
        d.winner = null;
        awards = [
          { player: a.player, outcome: "draw", points: POINTS.draw },
          { player: b.player, outcome: "draw", points: POINTS.draw },
        ];
      }
    }
    return true;
  }, DUEL_TTL_MS);

  if (err) return err;
  if (!ok) return fail("no such duel", 404);

  for (const a of awards) await store.recordOutcome(a.player, a.outcome, a.points);
  if (awards.length) await store.retireCode((await store.getDuel(duelId))!.code);

  return { duel: (await store.getDuel(duelId))! };
}

/**
 * What a participant sees. A score stays hidden until the viewer has played,
 * so nobody gets to decide how hard to try after seeing the target.
 */
export function view(duel: Duel, viewer: string) {
  const me = sideFor(duel, viewer);
  const over = duel.status === "settled" || duel.status === "expired";
  const reveal = over || (me?.score ?? null) !== null;

  const render = (s: Side | null) =>
    s === null
      ? null
      : {
          player: s.player,
          score: reveal || s.player.toLowerCase() === viewer.toLowerCase() ? s.score : null,
          played: s.score !== null,
        };

  return {
    id: duel.id,
    code: duel.code,
    status: duel.status,
    day: duel.day,
    challenger: render(duel.challenger),
    opponent: render(duel.opponent),
    youPlayed: (me?.score ?? null) !== null,
    winner: over ? duel.winner : undefined,
    result: over
      ? duel.winner === null
        ? "draw"
        : duel.winner.toLowerCase() === viewer.toLowerCase()
          ? "won"
          : "lost"
      : undefined,
  };
}

/**
 * An opponent who never shows up should not strand the player who did. After
 * the TTL, a duel with exactly one score becomes a walkover; one with none
 * just expires.
 */
export async function sweepDuels(now: number) {
  for (const d of await store.listDuels()) {
    if (d.status === "settled" || d.status === "expired") continue;
    if (now - d.createdAt <= DUEL_TTL_MS) continue;

    let walkover: string | null = null;
    await store.mutateDuel(d.id, (draft) => {
      if (draft.status === "settled" || draft.status === "expired") return undefined;
      const played = [draft.challenger, draft.opponent].filter(
        (s): s is Side => !!s && s.score !== null
      );
      draft.status = "expired";
      draft.winner = played.length === 1 ? played[0].player : null;
      if (played.length === 1) walkover = played[0].player;
      return true;
    }, DUEL_TTL_MS);

    if (walkover) await store.recordOutcome(walkover, "walkover", POINTS.walkover);
    await store.retireCode(d.code); // the code stops working once it is dead
  }
}
