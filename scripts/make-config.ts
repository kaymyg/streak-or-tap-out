import * as dotenv from "dotenv";
dotenv.config({ path: process.env.ENV_FILE || ".env" });
import * as fs from "fs";
import * as path from "path";

/**
 * Write web/deployed.json without redeploying contracts.
 *
 * deploy.ts writes this file as a side effect, which is fine the first time
 * but wrong afterwards: repointing the page at a hosted verifier should not
 * require deploying a fresh token and burning everyone's streaks. This writes
 * the config on its own.
 *
 *   CHAIN_ID=84532 \
 *   DAILYTAP_ADDR=0x... STREAK_ADDR=0x... \
 *   RPC_URL=https://sepolia.base.org \
 *   API_BASE=https://api.streakortapout.fun \
 *   npx ts-node scripts/make-config.ts
 *
 * Values fall back to .env, so after a deploy you usually only need API_BASE.
 */

const cfg = {
  chainId: Number(process.env.CHAIN_ID ?? 31337),
  dailyTap: process.env.DAILYTAP_ADDR ?? "",
  streak: process.env.STREAK_ADDR ?? "",
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  apiBase: process.env.API_BASE ?? "http://localhost:8787",
};

const problems: string[] = [];
if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.dailyTap)) problems.push("DAILYTAP_ADDR is not an address");
if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.streak)) problems.push("STREAK_ADDR is not an address");
if (!/^https?:\/\//.test(cfg.apiBase)) problems.push("API_BASE must start with http:// or https://");

// The exact mistake that produced a live site calling the visitor's own
// machine. Worth refusing rather than warning.
const localApi = /\/\/(localhost|127\.0\.0\.1)/.test(cfg.apiBase);
if (cfg.chainId !== 31337 && localApi) {
  problems.push(
    `API_BASE points at ${cfg.apiBase} but chainId is ${cfg.chainId}. ` +
    `A deployed page would call each visitor's own machine. Set API_BASE to the ` +
    `verifier's public URL, or pass ALLOW_LOCAL_API=1 if this is deliberate.`
  );
}

if (problems.length && !process.env.ALLOW_LOCAL_API) {
  console.error("refusing to write web/deployed.json:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

const out = path.resolve(__dirname, "..", "web", "deployed.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");

console.log(`wrote ${out}`);
console.log(JSON.stringify(cfg, null, 2));
if (localApi) {
  console.log("\nnote: apiBase is localhost. Fine for local play, or for the live");
  console.log("page calling a verifier on your own machine. Not usable by anyone else.");
}
