import { ethers } from "hardhat";

/**
 * Measure the real gas cost of a full deploy, so the ETH needed is a measured
 * number rather than a guess.
 *
 * Run against the local chain; gas used is the same on Base. What differs is
 * the price per unit, which is passed in as GWEI.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const rows: { step: string; gas: bigint }[] = [];

  const token = await (await ethers.getContractFactory("StreakToken")).deploy();
  await token.waitForDeployment();
  rows.push({
    step: "deploy StreakToken",
    gas: (await token.deploymentTransaction()!.wait())!.gasUsed,
  });

  const tap = await (
    await ethers.getContractFactory("DailyTap")
  ).deploy(await token.getAddress(), deployer.address);
  await tap.waitForDeployment();
  rows.push({
    step: "deploy DailyTap",
    gas: (await tap.deploymentTransaction()!.wait())!.gasUsed,
  });

  const grant = await token.grantRole(await token.MINTER_ROLE(), await tap.getAddress());
  rows.push({ step: "grantRole(MINTER_ROLE)", gas: (await grant.wait())!.gasUsed });

  const total = rows.reduce((a, r) => a + r.gas, 0n);

  console.log("\nstep                      gas used");
  console.log("-------------------------------------");
  for (const r of rows) {
    console.log(`${r.step.padEnd(24)}  ${r.gas.toString().padStart(9)}`);
  }
  console.log("-------------------------------------");
  console.log(`${"TOTAL".padEnd(24)}  ${total.toString().padStart(9)}`);

  // Base L2 execution gas is cheap; the L1 data fee usually dominates and is
  // not modelled here, so treat these as a floor and keep headroom.
  const ethUsd = Number(process.env.ETH_USD ?? 2404);
  console.log(`\nassuming ETH = $${ethUsd}\n`);
  console.log("gas price      L2 exec cost        in USD");
  console.log("------------------------------------------");
  for (const gwei of [0.005, 0.01, 0.05, 0.1, 1]) {
    const wei = total * BigInt(Math.round(gwei * 1e9));
    const eth = Number(ethers.formatEther(wei));
    console.log(
      `${(gwei + " gwei").padEnd(13)}  ${eth.toFixed(8)} ETH    $${(eth * ethUsd).toFixed(4)}`
    );
  }
  console.log(
    "\nNote: excludes Base's L1 data fee, which for a contract deploy is\n" +
    "usually the larger share. Budget several times the figures above."
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
