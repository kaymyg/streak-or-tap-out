import { ethers } from "ethers";
import assert from "node:assert/strict";
import { RPC, call, sleep, newPlayer, newFundedPlayer } from "./lib/client";

/**
 * The daily tap loop, end to end against a running chain + verifier.
 *
 *   npm run node          # terminal 1
 *   npm run deploy:local  # terminal 2
 *   npm run server        # terminal 3
 *   npm run e2e           # terminal 4
 */
const TAP_ABI = [
  "function tap(uint256 tapCount, uint256 day, uint256 avgTapCount, bytes sig)",
  "event Tapped(address indexed player, uint256 indexed day, uint256 tapCount, uint256 streak, uint256 reward)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const { body: cfg } = await call("/config");
  console.log(`verifier up · DailyTap ${cfg.dailyTap} · chain ${cfg.chainId}`);

  const provider = new ethers.JsonRpcProvider(RPC);
  const alice = await newFundedPlayer(provider);
  console.log(`player ${alice.address} (fresh wallet, funded)`);

  const tap = new ethers.Contract(cfg.dailyTap, TAP_ABI, alice.wallet);
  const token = process.env.STREAK_ADDR
    ? new ethers.Contract(process.env.STREAK_ADDR, ERC20_ABI, provider)
    : null;
  const before = token ? await token.balanceOf(alice.address) : 0n;

  // --- auth is required -----------------------------------------------------
  const anon = await call("/round/start", { body: { purpose: "daily" } });
  assert.equal(anon.status, 401, "an unauthenticated round should be refused");
  console.log("unauthenticated /round/start refused");

  // --- sign in --------------------------------------------------------------
  const { message, signature, nonce } = await alice.signIn(cfg.chainId);
  console.log(`signed in as ${alice.short()}`);

  // --- the SIWE nonce is single use ----------------------------------------
  const replay = await call("/auth/verify", { body: { message, signature } });
  assert.equal(replay.status, 401, "a reused SIWE nonce should be rejected");
  console.log("reused SIWE nonce rejected");

  // --- a forged token is refused -------------------------------------------
  const forged = await call("/round/start", {
    body: { purpose: "daily" },
    token: ethers.hexlify(ethers.randomBytes(32)),
  });
  assert.equal(forged.status, 401, "a made-up bearer token should be refused");
  console.log("forged bearer token refused");

  // --- open the round -------------------------------------------------------
  const start = await alice.api("/round/start", { purpose: "daily" });
  if (!start.ok) throw new Error(`round/start ${start.status}: ${JSON.stringify(start.body)}`);
  console.log(`round ${start.body.roundId.slice(0, 10)}… day ${start.body.day}`);

  // --- finishing early is refused ------------------------------------------
  const early = await alice.api("/round/end", { roundId: start.body.roundId, tapCount: 40 });
  assert.equal(early.status, 400, "a round shorter than MIN_ELAPSED_MS should be refused");
  console.log(`early finish refused (${early.body.error})`);

  console.log(`tapping for ${start.body.scoringWindowMs}ms…`);
  await sleep(start.body.scoringWindowMs + 400);

  // --- a superhuman score is refused ---------------------------------------
  const cheat = await alice.api("/round/end", { roundId: start.body.roundId, tapCount: 500 });
  assert.equal(cheat.status, 400, "500 taps in 5s should be refused");
  console.log(`superhuman score refused (max ${cheat.body.maxTaps})`);

  // --- someone else's round is not yours -----------------------------------
  const bob = newPlayer(provider);
  await bob.signIn(cfg.chainId);
  const stolen = await bob.api("/round/end", { roundId: start.body.roundId, tapCount: 38 });
  assert.equal(stolen.status, 403, "another player should not be able to close this round");
  console.log("cross-player round close refused");

  // --- a plausible score gets signed ---------------------------------------
  const TAPS = 38;
  const end = await alice.api("/round/end", { roundId: start.body.roundId, tapCount: TAPS });
  if (!end.ok) throw new Error(`round/end ${end.status}: ${JSON.stringify(end.body)}`);
  console.log(`signed ${end.body.tapCount} taps, avg ${end.body.avgTapCount}`);

  const reclose = await alice.api("/round/end", { roundId: start.body.roundId, tapCount: TAPS });
  assert.equal(reclose.status, 409, "a completed round should not be reusable");
  console.log("round re-close rejected");

  // --- submit on chain ------------------------------------------------------
  const tx = await tap.tap(
    BigInt(end.body.tapCount), BigInt(end.body.day), BigInt(end.body.avgTapCount), end.body.sig
  );
  const receipt = await tx.wait();
  const ev = receipt!.logs
    .map((l: any) => { try { return tap.interface.parseLog(l); } catch { return null; } })
    .find((p: any) => p && p.name === "Tapped");
  assert.ok(ev, "no Tapped event");
  console.log(`minted ${ethers.formatUnits(ev!.args.reward, 18)} $STREAK · streak ${ev!.args.streak}`);

  if (token) {
    const after = await token.balanceOf(alice.address);
    assert.ok(after > before, "balance did not increase");
    console.log(`balance ${ethers.formatUnits(before, 18)} -> ${ethers.formatUnits(after, 18)}`);
  }

  // --- the chain refuses a second tap today --------------------------------
  await assert.rejects(
    tap.tap(BigInt(end.body.tapCount), BigInt(end.body.day), BigInt(end.body.avgTapCount), end.body.sig),
    "the same signature should not settle twice"
  );
  console.log("on-chain replay rejected");

  // --- the server reads that from the chain, not from its own memory -------
  const second = await alice.api("/round/start", { purpose: "daily" });
  assert.equal(second.status, 409, "server should read lastDay from chain and refuse");
  console.log("second daily round refused via on-chain lastDay");

  console.log("\nDAILY E2E PASSED");
}

main().catch((e) => {
  console.error("\nDAILY E2E FAILED:", e.message ?? e);
  process.exitCode = 1;
});
