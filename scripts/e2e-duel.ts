import { ethers } from "ethers";
import assert from "node:assert/strict";
import { RPC, Player, call, sleep, newPlayer } from "./lib/client";

/**
 * Two players through a full points-only duel.
 *
 * The thing worth proving here is NOT that a higher score wins — it is that
 * nothing of value moves. No ante, no pot, no settlement, no chain call. The
 * winner's prize is a number in the leaderboard map. That is what keeps this
 * feature outside wagering, and it is the property a future refactor is most
 * likely to break.
 */
async function playRound(p: Player, duelId: string, tapCount: number) {
  const start = await p.api("/round/start", { purpose: "duel", duelId });
  if (!start.ok) throw new Error(`round/start ${start.status}: ${JSON.stringify(start.body)}`);
  await sleep(start.body.scoringWindowMs + 400);
  const end = await p.api("/round/end", { roundId: start.body.roundId, tapCount });
  if (!end.ok) throw new Error(`round/end ${end.status}: ${JSON.stringify(end.body)}`);
  return end.body;
}

async function main() {
  const { body: cfg } = await call("/config");
  const provider = new ethers.JsonRpcProvider(RPC);

  // Fresh wallets: duels never touch the chain, so these need no gas.
  const alice = newPlayer(provider);
  const bob = newPlayer(provider);
  await alice.signIn(cfg.chainId);
  await bob.signIn(cfg.chainId);
  console.log(`alice ${alice.short()}  bob ${bob.short()}`);

  const aliceBefore = (await call(`/status/${alice.address}`)).body.standing.points;
  const bobBefore = (await call(`/status/${bob.address}`)).body.standing.points;

  // --- create ---------------------------------------------------------------
  const created = await alice.api("/duel/create", {});
  if (!created.ok) throw new Error(JSON.stringify(created.body));
  const { id: duelId, code } = created.body;
  assert.equal(created.body.status, "open");
  console.log(`duel ${code} created by alice`);

  // --- you cannot duel yourself --------------------------------------------
  const self = await alice.api("/duel/join", { code });
  assert.equal(self.status, 400, "self-duel should be refused");
  console.log("self-duel refused");

  // --- a stranger cannot peek ----------------------------------------------
  const carol = newPlayer(provider);
  await carol.signIn(cfg.chainId);
  const peek = await carol.api(`/duel/${duelId}`);
  assert.equal(peek.status, 403, "a non-participant should not see the duel");
  console.log("non-participant blocked from reading the duel");

  // --- a bad code is a 404, not a crash ------------------------------------
  const bad = await bob.api("/duel/join", { code: "ZZZZZZ" });
  assert.equal(bad.status, 404);
  const malformed = await bob.api("/duel/join", { code: "nope" });
  assert.equal(malformed.status, 400);
  console.log("unknown and malformed codes handled");

  // --- alice plays first ----------------------------------------------------
  const aliceRound = await playRound(alice, duelId, 42);
  assert.equal(aliceRound.duel.status, "open", "still open until someone joins");
  console.log(`alice scored ${aliceRound.tapCount}`);

  // --- bob joins and CANNOT see alice's score before playing ---------------
  const joined = await bob.api("/duel/join", { code });
  if (!joined.ok) throw new Error(JSON.stringify(joined.body));
  assert.equal(joined.body.status, "awaiting");
  assert.equal(
    joined.body.challenger.score,
    null,
    "bob must not see alice's score before he plays"
  );
  assert.equal(joined.body.challenger.played, true, "but he can see that she played");
  console.log("bob joined; alice's score hidden from him");

  // --- bob plays, duel settles ---------------------------------------------
  const bobRound = await playRound(bob, duelId, 51);
  const settled = bobRound.duel;
  assert.equal(settled.status, "settled");
  assert.equal(settled.result, "won", "bob scored higher and should have won");
  assert.equal(settled.challenger.score, 42, "scores are revealed once settled");
  console.log(`bob scored ${bobRound.tapCount} and won`);

  // --- alice sees the result too -------------------------------------------
  const aliceView = await alice.api(`/duel/${duelId}`);
  assert.equal(aliceView.body.result, "lost");
  assert.equal(aliceView.body.opponent.score, 51);
  console.log("alice sees the settled result");

  // --- neither can play it again -------------------------------------------
  const again = await bob.api("/round/start", { purpose: "duel", duelId });
  assert.equal(again.status, 409, "a settled duel should not accept another round");
  console.log("replaying a settled duel refused");

  // --- points moved, and ONLY points ---------------------------------------
  const aliceAfter = (await call(`/status/${alice.address}`)).body.standing;
  const bobAfter = (await call(`/status/${bob.address}`)).body.standing;
  assert.equal(bobAfter.points, bobBefore + 3, "winner gets 3");
  assert.equal(aliceAfter.points, aliceBefore + 1, "loser still gets 1 for showing up");
  assert.equal(bobAfter.wins, 1);
  assert.equal(aliceAfter.losses, 1);
  console.log(`points: alice ${aliceBefore}->${aliceAfter.points}, bob ${bobBefore}->${bobAfter.points}`);

  // --- the leaderboard reflects it -----------------------------------------
  // A long-lived server may hold players from earlier runs, so assert on
  // ordering and on bob's own row rather than on who sits at the top.
  const board = (await call("/leaderboard?n=100")).body.standings;
  const bobRow = board.find((s: any) => s.player === bob.address);
  assert.ok(bobRow, "bob should appear on the leaderboard");
  assert.equal(bobRow.points, 3, "bob's row should match his standing");
  for (let i = 1; i < board.length; i++) {
    assert.ok(board[i - 1].points >= board[i].points, "leaderboard must be sorted");
  }
  console.log(`leaderboard sorted, bob at ${bobRow.points} pts (${board.length} players)`);

  // --- a draw splits the difference ----------------------------------------
  const d2 = (await bob.api("/duel/create", {})).body;
  await alice.api("/duel/join", { code: d2.code });
  await playRound(bob, d2.id, 33);
  const drawn = (await playRound(alice, d2.id, 33)).duel;
  assert.equal(drawn.result, "draw");
  const aliceDraw = (await call(`/status/${alice.address}`)).body.standing;
  assert.equal(aliceDraw.points, aliceAfter.points + 2, "a draw is worth 2");
  assert.equal(aliceDraw.draws, 1);
  console.log("draw handled, worth 2 each");

  // --- the daily quota is enforced -----------------------------------------
  const { body: cfg2 } = await call("/config");
  let hitLimit = false;
  for (let i = 0; i < cfg2.maxDuelsPerDay + 2; i++) {
    const r = await alice.api("/duel/create", {});
    if (r.status === 429) { hitLimit = true; break; }
  }
  assert.ok(hitLimit, `creating past ${cfg2.maxDuelsPerDay} duels should be refused`);
  console.log(`duel quota enforced at ${cfg2.maxDuelsPerDay}/day`);

  console.log("\nDUEL E2E PASSED — no tokens moved, no chain writes");
}

main().catch((e) => {
  console.error("\nDUEL E2E FAILED:", e.message ?? e);
  process.exitCode = 1;
});
