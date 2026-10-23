import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy order matters and the obvious one is impossible: you cannot grant
 * MINTER_ROLE to DailyTap before DailyTap exists.
 *
 *   1. deploy StreakToken
 *   2. deploy DailyTap(token, verifierAddress)
 *   3. token.grantRole(MINTER_ROLE, dailyTap)
 *
 * LOCAL vs LIVE
 *
 * On the local Hardhat chain this script is convenient: it invents a verifier
 * key and writes .env and web/deployed.json so `npm start` just works.
 *
 * On a live network every one of those conveniences is a hazard, so they are
 * all switched off:
 *
 *   - It refuses to invent a verifier key. A generated key is one you might
 *     lose, and on mainnet that key is the only thing that can authorize a
 *     mint.
 *   - It never overwrites .env or web/deployed.json. Those hold your working
 *     local setup, and a half-finished mainnet deploy that clobbered them
 *     would leave you unable to run anything while also not knowing your new
 *     addresses.
 *   - It writes an immutable record to deployments/ instead, because a
 *     mainnet address you lose is a contract you have abandoned.
 *   - Mainnet additionally requires CONFIRM_MAINNET=yes, so a mistyped
 *     --network cannot spend real money.
 */

const LOCAL_CHAIN = 31337n;
const BASE_MAINNET = 8453n;

function fail(msg: string): never {
  console.error(`\nrefusing to deploy:\n  ${msg}\n`);
  process.exit(1);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = net.chainId;
  const isLocal = chainId === LOCAL_CHAIN;
  const isMainnet = chainId === BASE_MAINNET;

  // --- preflight, before anything costs money -----------------------------
  //
  // Every check below runs BEFORE the CONFIRM_MAINNET gate, deliberately. It
  // means `npm run deploy:base` without that flag is a complete free dry run:
  // it reads the env file, validates both keys, reads the on-chain nonce and
  // balance, prints the addresses the deploy would produce, and only then
  // refuses. Putting the confirm gate first would have made the dry run
  // useless — you would learn nothing about whether your setup is correct
  // until the moment it was already spending money.

  let verifierPk = process.env.VERIFIER_PK;
  if (!verifierPk) {
    if (!isLocal) {
      fail(
        "VERIFIER_PK is not set.\n" +
        "  On a live network this script will not invent one: that key is the\n" +
        "  only thing that can authorize a mint, and a generated key is one you\n" +
        "  can lose. Generate it deliberately, store it, then set it here.\n" +
        "  It must NOT be the deployer key and it never needs funds."
      );
    }
    verifierPk = ethers.Wallet.createRandom().privateKey;
    console.log("local chain: generated a throwaway verifier key for this deploy.");
  }

  const verifier = (() => {
    try {
      return new ethers.Wallet(verifierPk!);
    } catch {
      fail("VERIFIER_PK is not a valid private key.");
    }
  })();

  if (verifier.address.toLowerCase() === deployer.address.toLowerCase()) {
    fail(
      "VERIFIER_PK and DEPLOYER_PK are the same key.\n" +
      "  The verifier key lives hot on a web server; the deployer key owns the\n" +
      "  contract and can rotate the verifier. Sharing them means a leak of the\n" +
      "  server key is also a loss of the contract."
    );
  }

  // Hardhat's default accounts. Their private keys are in public
  // documentation and identical on every machine, so deploying a live
  // contract from one means the owner key is public: anyone could rotate the
  // verifier and mint at will, and sweeper bots would take the gas money
  // first. The resulting contract addresses are also the well-known recycled
  // ones that already hold thousands of dollars of permanently stuck funds
  // sent there by mistake.
  const HARDHAT_ACCOUNTS = [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
    "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  ];
  if (!isLocal && HARDHAT_ACCOUNTS.includes(deployer.address.toLowerCase())) {
    fail(
      `deployer ${deployer.address} is a Hardhat default account.\n` +
      "  Its private key is published in Hardhat's own documentation. Deploying\n" +
      "  from it on a live network hands contract ownership to the public.\n" +
      "  Use a key you generated yourself."
    );
  }
  if (!isLocal && HARDHAT_ACCOUNTS.includes(verifier.address.toLowerCase())) {
    fail(
      `verifier ${verifier.address} is a Hardhat default account.\n` +
      "  Its private key is public, so anyone could sign taps and mint."
    );
  }

  // The verifier key lives on the server that signs every round, which makes
  // it the likeliest key here to leak. It must be a throwaway holding nothing.
  // The real Base deploy used a funded wallet, which would have meant putting
  // a wallet with money on an internet-facing host — the earlier
  // verifier-equals-deployer check did not catch it because they were
  // different keys.
  if (!isLocal) {
    const vBal = await ethers.provider.getBalance(verifier.address);
    if (vBal > 0n) {
      fail(
        `verifier ${verifier.address} holds ${ethers.formatEther(vBal)} ETH.\n` +
        "  That key has to sit on the server signing rounds, so it is the most\n" +
        "  exposed key in the system. Use a fresh key that holds nothing and is\n" +
        "  used for nothing else — never a wallet you keep funds in."
      );
    }
    const vTx = await ethers.provider.getTransactionCount(verifier.address);
    if (vTx > 0) {
      console.log(`WARNING: verifier has sent ${vTx} transaction(s) — not a fresh key.`);
    }
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`network  : ${network.name} (chainId ${chainId})`);
  console.log(`deployer : ${deployer.address}`);
  console.log(`balance  : ${ethers.formatEther(balance)} ETH`);
  console.log(`verifier : ${verifier.address}  (signs only, holds no funds)`);

  if (!isLocal) {
    // Measured: ~1.84M gas for the three transactions. Require headroom for
    // the L1 data fee, which for a contract deploy is usually the larger part.
    const fee = await ethers.provider.getFeeData();
    const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const estimate = 1_850_000n * gasPrice;
    console.log(`gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
    console.log(`est. L2  : ${ethers.formatEther(estimate)} ETH (excludes L1 data fee)`);
    if (balance === 0n) fail("deployer has no ETH on this network.");

    // Why a headroom factor at all: running out of gas part way through is
    // the worst outcome here. StreakToken would exist, DailyTap would not,
    // the MINTER_ROLE grant would never happen, and no record would be
    // written — so you would have paid for a token you then have to abandon
    // and redeploy both.
    //
    // Why it is overridable: getFeeData() reports the L2 gas price only. On
    // Base the L1 data fee is added per transaction and is not visible here,
    // so this estimate is a floor multiplied by a guess. If the guess is too
    // conservative it would block a deploy that would have worked fine.
    const want = estimate * 3n;
    if (balance < want && !process.env.ALLOW_LOW_BALANCE) {
      fail(
        `balance ${ethers.formatEther(balance)} ETH is below the ${ethers.formatEther(want)} ETH\n` +
        `  this wants as headroom (3x the L2 estimate, to cover the L1 data fee\n` +
        `  which is not visible from getFeeData()).\n\n` +
        `  Running out of gas mid-deploy leaves StreakToken deployed, DailyTap\n` +
        `  not, and the minter grant undone — you would redeploy both.\n\n` +
        `  If you have checked the real cost and this is too conservative, set\n` +
        `  ALLOW_LOW_BALANCE=1. Base typically runs far below the gas price a\n` +
        `  local simulation reports.`
      );
    }
    if (balance < want) {
      console.log(`WARNING: balance below the ${ethers.formatEther(want)} ETH headroom; proceeding because ALLOW_LOW_BALANCE is set.`);
    }
  }

  // Predict the addresses from the deployer's CURRENT nonce. A contract
  // address is keccak(rlp([deployer, nonce])) — no randomness — so these are
  // exactly what the deploy will produce, and seeing them beforehand is the
  // difference between knowing where your token will live and finding out.
  // They shift if the deployer sends any other transaction first.
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predicted = {
    streak: ethers.getCreateAddress({ from: deployer.address, nonce }),
    dailyTap: ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 }),
  };
  console.log(`nonce    : ${nonce}`);
  console.log(`will create:`);
  console.log(`  StreakToken -> ${predicted.streak}`);
  console.log(`  DailyTap    -> ${predicted.dailyTap}`);

  // The confirm gate goes LAST so everything above is a free dry run.
  if (isMainnet && process.env.CONFIRM_MAINNET !== "yes") {
    console.log("");
    fail(
      "preflight passed. Nothing has been spent.\n\n" +
      "  This is Base mainnet (8453) and the deploy is irreversible: the token\n" +
      "  will exist at its address forever, and fixing a bug means deploying a\n" +
      "  new one and abandoning every balance and streak in the old.\n\n" +
      "  Re-run with CONFIRM_MAINNET=yes to go ahead."
    );
  }

  console.log("");

  // --- deploy --------------------------------------------------------------

  const token = await (await ethers.getContractFactory("StreakToken")).deploy();
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log(`StreakToken -> ${tokenAddr}`);

  const tap = await (
    await ethers.getContractFactory("DailyTap")
  ).deploy(tokenAddr, verifier.address);
  await tap.waitForDeployment();
  const tapAddr = await tap.getAddress();
  console.log(`DailyTap    -> ${tapAddr}`);

  const grant = await token.grantRole(await token.MINTER_ROLE(), tapAddr);
  await grant.wait();
  console.log(`granted MINTER_ROLE to DailyTap`);

  // --- verify what actually landed on chain --------------------------------
  //
  // These reads are RETRIED, which matters more than it looks.
  //
  // A public RPC endpoint is a load balancer in front of many nodes.
  // grant.wait() returns after one confirmation, but the very next eth_call
  // can be routed to a node that has not caught up yet, so hasRole() comes
  // back false for a grant that definitely succeeded. The first version of
  // this script asserted once and exited 1 — which is exactly what happened
  // on the real Base deploy: it announced "MINTER_ROLE grant failed" while
  // the transaction was on chain and successful, and the only way to find out
  // was to go and read the chain by hand.
  //
  // A false alarm here is expensive: it tells you an irreversible mainnet
  // deploy is broken when it is fine, and the obvious response is to deploy
  // again and pay twice.
  async function settles(
    label: string,
    read: () => Promise<boolean>,
    attempts = 10
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        if (await read()) return true;
      } catch {
        // a lagging node can also throw rather than answer
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(`  (gave up waiting for: ${label})`);
    return false;
  }

  const role = await token.MINTER_ROLE();
  const checks: [string, boolean][] = [
    ["DailyTap holds MINTER_ROLE", await settles("MINTER_ROLE", () => token.hasRole(role, tapAddr))],
    ["deployer does NOT hold MINTER_ROLE", !(await token.hasRole(role, deployer.address))],
    ["DailyTap points at StreakToken", await settles("streak ref", async () => (await tap.streak()) === tokenAddr)],
    ["verifier is set as expected", await settles("verifier", async () => (await tap.verifier()) === verifier.address)],
    ["deployer owns DailyTap", await settles("owner", async () => (await tap.owner()) === deployer.address)],
    ["token supply starts at zero", (await token.totalSupply()) === 0n],
  ];
  console.log("");
  for (const [label, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (checks.some(([, ok]) => !ok)) {
    console.error(
      "\nDeploy transactions went through but a check did not confirm.\n" +
      "Before redeploying anything, read the chain directly — a lagging RPC\n" +
      "reports a healthy deploy as broken, and redeploying costs you twice.\n" +
      `  StreakToken: ${tokenAddr}\n  DailyTap:    ${tapAddr}`
    );
    process.exit(1);
  }

  // --- record --------------------------------------------------------------

  const root = path.resolve(__dirname, "..");
  const record = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    verifier: verifier.address,
    streak: tokenAddr,
    dailyTap: tapAddr,
    txs: {
      streak: token.deploymentTransaction()?.hash,
      dailyTap: tap.deploymentTransaction()?.hash,
      grantRole: grant.hash,
    },
  };

  const dir = path.join(root, "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const recPath = path.join(dir, `${network.name}-${Date.now()}.json`);
  fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nrecorded ${recPath}`);

  if (isLocal) {
    // Local only: write the files that make `npm start` work with no setup.
    fs.writeFileSync(
      path.join(root, ".env"),
      [
        "# Written by scripts/deploy.ts on the LOCAL chain. Throwaway keys only.",
        `RPC_URL=http://127.0.0.1:8545`,
        `CHAIN_ID=${chainId}`,
        `DAILYTAP_ADDR=${tapAddr}`,
        `STREAK_ADDR=${tokenAddr}`,
        `VERIFIER_PK=${verifierPk}`,
        `SIWE_DOMAIN=localhost:5173`,
        `ALLOWED_ORIGINS=http://localhost:5173`,
        `PORT=8787`,
        "",
      ].join("\n")
    );
    const webCfg = path.join(root, "web", "deployed.json");
    fs.mkdirSync(path.dirname(webCfg), { recursive: true });
    fs.writeFileSync(
      webCfg,
      JSON.stringify(
        {
          chainId: Number(chainId),
          dailyTap: tapAddr,
          streak: tokenAddr,
          rpcUrl: "http://127.0.0.1:8545",
          apiBase: process.env.API_BASE ?? "http://localhost:8787",
        },
        null,
        2
      ) + "\n"
    );
    console.log(`wrote .env and web/deployed.json`);
    return;
  }

  // Live network: print, do not write. Clobbering the working local config
  // mid-deploy would leave nothing runnable and no record of the new addresses.
  console.log(`
Nothing else was written — your local .env and web/deployed.json are untouched.

Next, on the host that will run the verifier:

  CHAIN_ID=${chainId}
  RPC_URL=<your ${network.name} RPC>
  DAILYTAP_ADDR=${tapAddr}
  STREAK_ADDR=${tokenAddr}
  VERIFIER_PK=<the same key whose address is ${verifier.address}>
  REDIS_URL=<managed redis>
  SIWE_DOMAIN=<the host serving the page>
  ALLOWED_ORIGINS=https://<the host serving the page>

Then point the page at it and redeploy:

  CHAIN_ID=${chainId} \\
  DAILYTAP_ADDR=${tapAddr} \\
  STREAK_ADDR=${tokenAddr} \\
  RPC_URL=<your ${network.name} RPC> \\
  API_BASE=https://<verifier host> \\
  npm run config
  cd web && npx vercel --prod

Until the verifier is reachable at a public https URL, nobody can earn: the
contracts are live but the only thing that can authorize a tap is that server.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
