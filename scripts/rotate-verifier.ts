import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Point DailyTap at a different verifier key.
 *
 * Why this exists: DailyTap stores the verifier's ADDRESS, chosen once at
 * deploy time, and the matching private key has to sit on whatever server
 * signs rounds. That makes it the most exposed key in the system — so it must
 * be a throwaway that holds nothing and is used for nothing else.
 *
 * On the real Base deploy it ended up being a funded wallet instead, which
 * means running the server would have put a wallet with real money on an
 * internet-facing host. One transaction fixes that.
 *
 * Only the owner can call setVerifier, so DEPLOYER_PK must be the owner's key.
 *
 *   NEW_VERIFIER=0x...        the ADDRESS to trust (not a private key)
 *   $env:ENV_FILE=".env"; npx hardhat run scripts/rotate-verifier.ts --network base
 *
 * Generate the new key, keep it somewhere safe, and pass only its address:
 *   node -e "const w=require('ethers').Wallet.createRandom(); console.log('ADDRESS:',w.address); console.log('KEY:',w.privateKey)"
 */

function fail(msg: string): never {
  console.error(`\nrefusing to rotate:\n  ${msg}\n`);
  process.exit(1);
}

async function main() {
  const tapAddr = process.env.DAILYTAP_ADDR;
  const next = process.env.NEW_VERIFIER;

  if (!tapAddr) fail("DAILYTAP_ADDR is not set.");
  if (!next) {
    fail(
      "NEW_VERIFIER is not set. Pass the ADDRESS of the new verifier.\n" +
      "  Generate one with:\n" +
      "    node -e \"const w=require('ethers').Wallet.createRandom(); console.log(w.address, w.privateKey)\"\n" +
      "  Store the private key safely — the server needs it, and losing it means\n" +
      "  rotating again."
    );
  }
  if (!ethers.isAddress(next)) fail(`NEW_VERIFIER "${next}" is not a valid address.`);

  const nextAddr = ethers.getAddress(next);
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const tap = await ethers.getContractAt("DailyTap", tapAddr);

  const [owner, current] = await Promise.all([tap.owner(), tap.verifier()]);

  console.log(`network  : ${network.name} (chainId ${net.chainId})`);
  console.log(`DailyTap : ${tapAddr}`);
  console.log(`owner    : ${owner}`);
  console.log(`signing  : ${signer.address}`);
  console.log(`verifier : ${current}  ->  ${nextAddr}\n`);

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    fail(
      `only the owner can rotate the verifier.\n` +
      `  owner is  ${owner}\n` +
      `  you are   ${signer.address}\n` +
      `  Set DEPLOYER_PK to the owner's key.`
    );
  }
  if (current.toLowerCase() === nextAddr.toLowerCase()) {
    console.log("already set to that address. Nothing to do.");
    return;
  }

  // The new verifier must be a key that holds nothing. If it has a balance it
  // is a wallet someone uses, and its key does not belong on a web server.
  const bal = await ethers.provider.getBalance(nextAddr);
  if (bal > 0n) {
    fail(
      `${nextAddr} holds ${ethers.formatEther(bal)} ETH.\n` +
      "  The verifier key lives on the server that signs every round, so it is\n" +
      "  the most likely key in this system to leak. It must be a throwaway that\n" +
      "  holds nothing and is used for nothing else — never a funded wallet.\n" +
      "  Generate a fresh key and use that address instead."
    );
  }

  const txCount = await ethers.provider.getTransactionCount(nextAddr);
  if (txCount > 0) {
    console.log(`WARNING: ${nextAddr} has sent ${txCount} transaction(s) — it is not a fresh key.`);
  }

  const tx = await tap.setVerifier(nextAddr);
  console.log(`tx ${tx.hash}`);
  await tx.wait();

  // Re-read with retries: a public RPC can answer from a node behind the tip,
  // which would report a successful rotation as failed.
  let confirmed = "";
  for (let i = 0; i < 10; i++) {
    confirmed = await tap.verifier();
    if (confirmed.toLowerCase() === nextAddr.toLowerCase()) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (confirmed.toLowerCase() !== nextAddr.toLowerCase()) {
    console.error(
      `\nTransaction sent but the contract still reports ${confirmed}.\n` +
      "Read the chain directly before sending another — a lagging RPC reports a\n" +
      "successful rotation as failed."
    );
    process.exit(1);
  }

  console.log(`\nok  verifier is now ${confirmed}`);

  const dir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const rec = path.join(dir, `rotate-${network.name}-${Date.now()}.json`);
  fs.writeFileSync(
    rec,
    JSON.stringify(
      {
        network: network.name,
        chainId: Number(net.chainId),
        at: new Date().toISOString(),
        dailyTap: tapAddr,
        previousVerifier: current,
        newVerifier: confirmed,
        tx: tx.hash,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`recorded ${rec}`);
  console.log("\nNow set VERIFIER_PK on the server to the key for this address,");
  console.log("and re-run verify to confirm they agree.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
