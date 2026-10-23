import { ethers, network } from "hardhat";

/**
 * Read the state of an already-deployed pair of contracts and report it.
 *
 * This exists because of what happened on the real Base deploy: the deploy
 * script's one-shot assertion said "MINTER_ROLE grant failed" while the grant
 * was on chain and successful — a lagging public RPC answered a read that had
 * been routed to a node behind the tip. The only way to settle it was to read
 * the chain by hand.
 *
 * So: a cheap, read-only, retrying check you can run any time, against any
 * network, without touching anything.
 *
 *   $env:ENV_FILE=".env.base"; npx hardhat run scripts/verify-deployment.ts --network base
 *
 * Addresses come from DAILYTAP_ADDR and STREAK_ADDR, or from argv.
 */

const RETRIES = 8;

async function stable<T>(read: () => Promise<T>): Promise<T | null> {
  for (let i = 0; i < RETRIES; i++) {
    try {
      return await read();
    } catch {
      if (i < RETRIES - 1) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}

async function main() {
  const tapAddr = process.env.DAILYTAP_ADDR;
  const tokenAddr = process.env.STREAK_ADDR;

  if (!tapAddr || !tokenAddr) {
    console.error("set DAILYTAP_ADDR and STREAK_ADDR (e.g. in .env.base)");
    process.exit(1);
  }

  const net = await ethers.provider.getNetwork();
  console.log(`network : ${network.name} (chainId ${net.chainId})`);
  console.log(`token   : ${tokenAddr}`);
  console.log(`tap     : ${tapAddr}\n`);

  // Code must exist at both addresses. An address with no code accepts calls
  // and silently does nothing, which is the most misleading failure there is.
  for (const [label, addr] of [["StreakToken", tokenAddr], ["DailyTap", tapAddr]] as const) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") {
      console.error(`FAIL  no contract code at ${label} ${addr} on this network.`);
      console.error("      Calls to it will succeed and do nothing. Wrong network, or wrong address.");
      process.exit(1);
    }
    console.log(`  ok   ${label} has code (${(code.length - 2) / 2} bytes)`);
  }

  const token = await ethers.getContractAt("StreakToken", tokenAddr);
  const tap = await ethers.getContractAt("DailyTap", tapAddr);

  const role = await token.MINTER_ROLE();
  const [tapHasRole, streakRef, verifier, owner, supply, cap, day] = await Promise.all([
    stable(() => token.hasRole(role, tapAddr)),
    stable(() => tap.streak()),
    stable(() => tap.verifier()),
    stable(() => tap.owner()),
    stable(() => token.totalSupply()),
    stable(() => token.MAX_SUPPLY()),
    stable(() => tap.currentDay()),
  ]);

  const rows: [string, boolean, string][] = [
    ["DailyTap holds MINTER_ROLE", tapHasRole === true, String(tapHasRole)],
    [
      "DailyTap points at this token",
      streakRef?.toLowerCase() === tokenAddr.toLowerCase(),
      String(streakRef),
    ],
    ["verifier is set (non-zero)", !!verifier && verifier !== ethers.ZeroAddress, String(verifier)],
    ["owner is set (non-zero)", !!owner && owner !== ethers.ZeroAddress, String(owner)],
  ];

  console.log("");
  for (const [label, ok, value] of rows) {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(30)} ${value}`);
  }

  console.log("");
  console.log(`  supply      ${ethers.formatUnits(supply ?? 0n, 18)} / ${ethers.formatUnits(cap ?? 0n, 18)} STREAK`);
  console.log(`  currentDay  ${day}`);
  console.log(`  verifier    ${verifier}`);
  console.log(`  owner       ${owner}`);

  // The failure this catches is nasty and silent: DailyTap stores the
  // verifier's ADDRESS, set once at deploy time. If the key your server signs
  // with is a different one, the round works, the signature is produced, the
  // player pays gas — and tap() reverts with BadSignature every single time.
  //
  // It is easy to end up here. An earlier version of the deploy script
  // invented a verifier key when VERIFIER_PK was unset and wrote it to .env,
  // so the key the contract trusts can be sitting in a different env file
  // from the one the server loads.
  if (process.env.VERIFIER_PK) {
    let mine: string | null = null;
    try {
      mine = new ethers.Wallet(process.env.VERIFIER_PK).address;
    } catch {
      console.log("\n  FAIL VERIFIER_PK in this env file is not a valid private key.");
    }
    if (mine) {
      const match = mine.toLowerCase() === String(verifier).toLowerCase();
      console.log("");
      console.log(`  ${match ? "ok  " : "FAIL"} VERIFIER_PK matches the on-chain verifier`);
      console.log(`       env file says : ${mine}`);
      console.log(`       contract says : ${verifier}`);
      if (!match) {
        console.error(
          "\nThese must be the same key. As it stands the server would sign with a\n" +
          "key the contract does not trust, and every tap would revert with\n" +
          "BadSignature after the player has already paid gas.\n\n" +
          "Either point the server at the key whose address the contract holds,\n" +
          "or rotate the contract to this one:\n" +
          `  DailyTap(${tapAddr}).setVerifier(${mine})\n` +
          "  — callable only by the owner, " + owner
        );
        process.exit(1);
      }
    }
  } else {
    console.log("\n  note: VERIFIER_PK not set in this env file, so it was not compared.");
    console.log("        The server must sign with the key whose address is above.");
  }

  const failed = rows.filter(([, ok]) => !ok);
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed — the game cannot mint in this state.`);
    process.exit(1);
  }
  console.log("\nAll checks passed. These contracts are wired correctly.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
