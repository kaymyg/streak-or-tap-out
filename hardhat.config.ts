import * as dotenv from "dotenv";
import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";

// Load an env file so DEPLOYER_PK and friends do not have to be exported by
// hand. ENV_FILE picks which one, so mainnet settings can live in their own
// file instead of overwriting the working local .env:
//
//   ENV_FILE=.env.base npx hardhat run scripts/deploy.ts --network base
//
// Without this, hardhat read only shell variables and a DEPLOYER_PK sitting
// in an env file was silently ignored — the deploy would run with no account
// and fail in a way that looks like a network problem.
dotenv.config({ path: process.env.ENV_FILE || ".env" });

const SOLC_VERSION = "0.8.24";

// This sandbox cannot reach binaries.soliditylang.org, so Hardhat's usual
// "download the compiler on first run" step fails. The solc build published to
// npm is the same compiler, so point Hardhat at that instead. On a normal
// machine with open network access you can delete this subtask override and
// Hardhat will download the compiler itself.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: any, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: require("solc/package.json").version,
    };
  }
  return runSuper();
});

const config: HardhatUserConfig = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    // `npx hardhat node` serves this on http://127.0.0.1:8545
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    baseSepolia: {
      // BASE_SEPOLIA_RPC first; RPC_URL still works but is shared with the
      // server, so prefer the specific one to avoid a localhost RPC_URL being
      // picked up by a testnet deploy.
      url: process.env.BASE_SEPOLIA_RPC ?? process.env.RPC_URL ?? "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [],
    },
    // Base mainnet. Real money, and a deploy here cannot be undone: the token
    // exists at its address forever, and fixing a bug means deploying a new
    // one and abandoning every balance and streak in the old.
    base: {
      url: process.env.BASE_RPC ?? "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PK ? [process.env.DEPLOYER_PK] : [],
    },
  },
};

export default config;
