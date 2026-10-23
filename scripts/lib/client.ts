import "dotenv/config";
import { ethers } from "ethers";

/**
 * A headless player, used by the e2e scripts.
 *
 * It builds the SIWE message BY HAND in exactly the format web/index.html
 * uses, so these scripts also test the browser's hand-rolled EIP-4361 string
 * against the server's siwe parser. If the blank lines in that template ever
 * drift, it fails here instead of in someone's wallet.
 */

export const API = process.env.API ?? "http://localhost:8787";
export const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const SIWE_DOMAIN = process.env.SIWE_DOMAIN ?? "localhost:5173";
export const ORIGIN = process.env.ORIGIN ?? "http://localhost:5173";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildSiwe(o: {
  domain: string; address: string; uri: string;
  chainId: number; nonce: string; statement: string;
}) {
  return [
    `${o.domain} wants you to sign in with your Ethereum account:`,
    o.address,
    ``,
    o.statement,
    ``,
    `URI: ${o.uri}`,
    `Version: 1`,
    `Chain ID: ${o.chainId}`,
    `Nonce: ${o.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

export type Res = { ok: boolean; status: number; body: any };

export async function call(
  path: string,
  opts: { method?: string; body?: any; token?: string } = {}
): Promise<Res> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export class Player {
  wallet: ethers.Wallet;
  token = "";
  constructor(pk: string, provider: ethers.Provider) {
    this.wallet = new ethers.Wallet(pk, provider);
  }
  get address() {
    return this.wallet.address;
  }
  short() {
    return `${this.address.slice(0, 6)}…${this.address.slice(-4)}`;
  }

  async signIn(chainId: number, statement = "Start a Streak or Tap Out round.") {
    const { body: n } = await call("/auth/nonce");
    const message = buildSiwe({
      domain: SIWE_DOMAIN,
      address: ethers.getAddress(this.address),
      uri: ORIGIN,
      chainId,
      nonce: n.nonce,
      statement,
    });
    const signature = await this.wallet.signMessage(message);
    const res = await call("/auth/verify", { body: { message, signature } });
    if (!res.ok) throw new Error(`sign-in failed: ${JSON.stringify(res.body)}`);
    this.token = res.body.token;
    return { message, signature, nonce: n.nonce };
  }

  api(path: string, body?: any, method?: string) {
    return call(path, { body, method, token: this.token });
  }
}

/** Hardhat's deterministic local accounts. Test keys, local chain only. */
export const HARDHAT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

/**
 * Both suites use FRESH random wallets every run.
 *
 * Using Hardhat's fixed accounts meant the second run always failed on
 * "already tapped today" and "duel limit reached" — real behaviour, but it
 * made the suites pass exactly once per chain. A test you have to reset the
 * world to run is a test you stop running. A new address has no streak, no
 * daily tap, and no duel quota, so these are now idempotent against a
 * long-lived chain and a long-lived server.
 */
export function newPlayer(provider: ethers.Provider): Player {
  return new Player(ethers.Wallet.createRandom().privateKey, provider);
}

/** Same, plus gas — only the daily suite sends transactions. */
export async function newFundedPlayer(
  provider: ethers.JsonRpcProvider,
  ether = "1"
): Promise<Player> {
  const player = newPlayer(provider);
  const funder = new ethers.Wallet(HARDHAT_KEYS[0], provider);
  const tx = await funder.sendTransaction({
    to: player.address,
    value: ethers.parseEther(ether),
  });
  await tx.wait();
  return player;
}
