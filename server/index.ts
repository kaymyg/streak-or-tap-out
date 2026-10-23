import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";

import {
  CONFIG,
  SCORING_WINDOW_MS,
  SESSION_TTL_MS,
  REF_AVG,
  MAX_ATTEMPTS_PER_DAY,
  MAX_DUELS_PER_DAY,
  DUEL_TTL_MS,
} from "./config";
import { signer, dailyTap, currentDay, lastDayOf, signTap } from "./chain";
import { store, storeDescription } from "./db";
import { authRouter, requireAuth, AuthedRequest } from "./auth";
import { openRound, checkPlausible } from "./rounds";
import * as duels from "./duels";

/**
 * THE VERIFIER
 *
 * The contract can only check that this server signed something. So every
 * anti-cheat guarantee in the game is whatever happens here before signTap()
 * is called. A server that signs a client-supplied score is not a verifier, it
 * is a rubber stamp.
 *
 * Two modes share one round mechanism:
 *   daily -> ends in an EIP-712 signature the player submits on chain
 *   duel  -> ends in a number in the store. No tokens, no chain, no settlement.
 */

const app = express();

app.use(
  cors({
    // Explicit allowlist, never "*" — this service signs things.
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / same-origin
      cb(null, CONFIG.ALLOWED_ORIGINS.includes(origin));
    },
    credentials: false,
  })
);
app.use(express.json({ limit: "4kb" }));
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true }));

const daily = (player: string, day: number) => `daily:${player}:${day}`;

// --- public -----------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true, store: storeDescription }));

app.get("/config", (_req, res) => {
  res.json({
    chainId: CONFIG.CHAIN_ID,
    dailyTap: CONFIG.DAILYTAP_ADDR,
    siweDomains: CONFIG.SIWE_DOMAINS,
    scoringWindowMs: SCORING_WINDOW_MS,
    refAvg: REF_AVG.toString(),
    maxDuelsPerDay: MAX_DUELS_PER_DAY,
  });
});

app.get("/status/:player", async (req, res) => {
  const raw = String(req.params.player);
  if (!ethers.isAddress(raw)) return res.status(400).json({ error: "bad address" });
  const player = ethers.getAddress(raw);
  try {
    const [day, last, streak, projected] = await Promise.all([
      dailyTap.currentDay(),
      dailyTap.lastDay(player),
      dailyTap.streakOf(player),
      dailyTap.projectedStreak(player),
    ]);
    const [standing, duelsToday] = await Promise.all([
      store.standing(player),
      duels.duelsStartedToday(player, Number(day)),
    ]);
    res.json({
      day: Number(day),
      tappedToday: Number(last) >= Number(day),
      streak: Number(streak),
      projectedStreak: Number(projected),
      standing,
      duelsStartedToday: duelsToday,
    });
  } catch (e: any) {
    res.status(502).json({ error: "chain read failed", detail: String(e?.message ?? e) });
  }
});

app.get("/leaderboard", async (req, res) => {
  const n = Math.min(100, Math.max(1, Number(req.query.n ?? 20)));
  res.json({ standings: await store.topStandings(n) });
});

app.use("/auth", authRouter);

// --- rounds -----------------------------------------------------------------

app.post("/round/start", requireAuth, async (req: AuthedRequest, res) => {
  const player = req.player!;
  const purpose = req.body?.purpose === "duel" ? "duel" : "daily";

  let day: number;
  try {
    day = await currentDay();
  } catch (e: any) {
    return res.status(502).json({ error: "chain read failed", detail: String(e?.message ?? e) });
  }

  if (purpose === "duel") {
    const duel = await duels.get(String(req.body?.duelId ?? ""));
    if (!duel) return res.status(404).json({ error: "no such duel" });
    const side = duels.sideFor(duel, player);
    if (!side) return res.status(403).json({ error: "you are not in this duel" });
    if (side.score !== null) return res.status(409).json({ error: "you already played this duel" });
    if (duel.status === "settled" || duel.status === "expired") {
      return res.status(409).json({ error: "this duel is over" });
    }
    const round = await openRound(player, "duel", day, duel.id);
    return res.json({ roundId: round.id, purpose, day, scoringWindowMs: SCORING_WINDOW_MS });
  }

  // THE one-tap-per-day gate is the chain's, not ours. A server-side flag set
  // at round open would burn the player's day whenever they rejected the
  // wallet popup, ran out of gas, or closed the tab — and on day 29 of a
  // streak that is the one failure this game cannot have.
  let last: number;
  try {
    last = await lastDayOf(player);
  } catch (e: any) {
    return res.status(502).json({ error: "chain read failed", detail: String(e?.message ?? e) });
  }
  if (last >= day) {
    return res.status(409).json({ error: "already tapped today", day, lastDay: last });
  }

  // Retries are allowed so an abandoned round does not forfeit the day, but
  // capped so the game does not become best-of-fifty.
  const quota = await store.takeQuota(daily(player, day), MAX_ATTEMPTS_PER_DAY, DUEL_TTL_MS);
  if (!quota.allowed) {
    return res.status(429).json({
      error: "too many attempts today",
      attempts: quota.used,
      max: MAX_ATTEMPTS_PER_DAY,
    });
  }

  const round = await openRound(player, "daily", day);
  res.json({
    roundId: round.id,
    purpose,
    day,
    scoringWindowMs: SCORING_WINDOW_MS,
    attempt: quota.used,
    attemptsRemaining: MAX_ATTEMPTS_PER_DAY - quota.used,
  });
});

app.post("/round/end", requireAuth, async (req: AuthedRequest, res) => {
  const player = req.player!;
  const roundId = String(req.body?.roundId ?? "");

  const peek = await store.getRound(roundId);
  if (!peek) return res.status(404).json({ error: "no such round (or it expired)" });
  if (peek.player !== player) return res.status(403).json({ error: "not your round" });
  if (peek.completed) return res.status(409).json({ error: "round already completed" });

  // Check plausibility BEFORE claiming. A refused score should leave the round
  // open so the player can finish it properly; claiming first would burn the
  // round on a transient client glitch.
  const check = checkPlausible(peek, req.body?.tapCount);
  if (!check.ok) return res.status(check.status).json(check.body);

  // Claim is atomic and single-winner: two concurrent /round/end calls cannot
  // both produce a signature.
  const round = await store.claimRound(roundId);
  if (!round) return res.status(409).json({ error: "round already completed" });

  if (round.purpose === "duel") {
    const result = await duels.submitScore(round.duelId!, player, check.tapCount);
    if ("error" in result) return res.status(result.status).json({ error: result.error });
    return res.json({ tapCount: check.tapCount, duel: duels.view(result.duel, player) });
  }

  // The UTC day can roll over mid-round. The contract requires
  // day == currentDay(), so signing the stale day would produce a signature
  // that reverts on submission.
  let today: number;
  try {
    today = await currentDay();
  } catch (e: any) {
    return res.status(502).json({ error: "chain read failed", detail: String(e?.message ?? e) });
  }
  if (today !== round.day) {
    await store.deleteRound(round.id);
    return res.status(409).json({
      error: "the UTC day rolled over mid-round — play again",
      roundDay: round.day,
      today,
    });
  }

  const sig = await signTap(player, check.tapCount, round.day, REF_AVG);

  res.json({
    sig,
    player,
    tapCount: String(check.tapCount),
    day: String(round.day),
    avgTapCount: String(REF_AVG),
  });
});

// --- duels ------------------------------------------------------------------

app.post("/duel/create", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const result = await duels.create(req.player!, await currentDay());
    if ("error" in result) return res.status(result.status).json({ error: result.error });
    res.json(duels.view(result, req.player!));
  } catch (e: any) {
    res.status(502).json({ error: "chain read failed", detail: String(e?.message ?? e) });
  }
});

app.post("/duel/join", requireAuth, async (req: AuthedRequest, res) => {
  const code = String(req.body?.code ?? "").trim();
  if (!/^[A-Za-z0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: "a duel code is six letters and digits" });
  }
  try {
    const result = await duels.join(req.player!, code, await currentDay());
    if ("error" in result) return res.status(result.status).json({ error: result.error });
    res.json(duels.view(result, req.player!));
  } catch (e: any) {
    res.status(502).json({ error: "chain read failed", detail: String(e?.message ?? e) });
  }
});

app.get("/duel/:id", requireAuth, async (req: AuthedRequest, res) => {
  const duel = await duels.get(String(req.params.id));
  if (!duel) return res.status(404).json({ error: "no such duel" });
  if (!duels.sideFor(duel, req.player!)) {
    return res.status(403).json({ error: "you are not in this duel" });
  }
  res.json(duels.view(duel, req.player!));
});

// --- boot -------------------------------------------------------------------

async function main() {
  await store.connect();

  setInterval(() => {
    const now = Date.now();
    // Redis expires its own keys; the memory store needs sweeping. Both are
    // called so the two behave identically from the outside.
    store.sweep(now).catch((e) => console.error("sweep failed", e));
    duels.sweepDuels(now).catch((e) => console.error("duel sweep failed", e));
  }, 60_000).unref();

  app.listen(CONFIG.PORT, () => {
    console.log(`verifier listening on :${CONFIG.PORT}`);
    console.log(`  verifier address : ${signer.address}`);
    console.log(`  DailyTap         : ${CONFIG.DAILYTAP_ADDR}`);
    console.log(`  chainId          : ${CONFIG.CHAIN_ID}`);
    console.log(`  SIWE domains     : ${CONFIG.SIWE_DOMAINS.join(", ")}`);
    console.log(`  allowed origins  : ${CONFIG.ALLOWED_ORIGINS.join(", ")}`);
    console.log(`  store            : ${storeDescription}`);
  });
}

main().catch((e) => {
  console.error("failed to start:", e);
  process.exit(1);
});
