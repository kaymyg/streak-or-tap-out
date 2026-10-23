import { ethers } from "ethers";
import { CONFIG } from "./config";

/**
 * Everything that touches the chain, in one place.
 *
 * Note what is NOT here: duels. A points-only duel has nothing to settle, so
 * it never reaches the chain at all. That is the whole reason the duel feature
 * carries no legal exposure and needs no contract.
 */

export const signer = new ethers.Wallet(CONFIG.VERIFIER_PK);
export const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);

export const dailyTap = new ethers.Contract(
  CONFIG.DAILYTAP_ADDR,
  [
    "function currentDay() view returns (uint256)",
    "function lastDay(address) view returns (uint256)",
    "function streakOf(address) view returns (uint256)",
    "function projectedStreak(address) view returns (uint256)",
  ],
  provider
);

export const EIP712_DOMAIN = {
  name: "DailyTap",
  version: "1",
  chainId: CONFIG.CHAIN_ID,
  verifyingContract: CONFIG.DAILYTAP_ADDR,
};

export const TAP_TYPE = {
  Tap: [
    { name: "player", type: "address" },
    { name: "tapCount", type: "uint256" },
    { name: "day", type: "uint256" },
    { name: "avgTapCount", type: "uint256" },
  ],
};

export async function currentDay(): Promise<number> {
  return Number(await dailyTap.currentDay());
}

export async function lastDayOf(player: string): Promise<number> {
  return Number(await dailyTap.lastDay(player));
}

/** The only place the verifier key is ever used. */
export function signTap(player: string, tapCount: number, day: number, avg: bigint) {
  return signer.signTypedData(EIP712_DOMAIN, TAP_TYPE, {
    player,
    tapCount: BigInt(tapCount),
    day: BigInt(day),
    avgTapCount: avg,
  });
}
