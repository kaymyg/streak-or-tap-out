import { Router, Request, Response, NextFunction } from "express";
import { SiweMessage } from "siwe";
import { generateNonce } from "siwe";
import { ethers } from "ethers";
import { CONFIG, NONCE_TTL_MS, TOKEN_TTL_MS } from "./config";
import { store } from "./db";

/**
 * SIWE once, then a bearer token.
 *
 * The daily tap only needed a single authenticated call, so signing per action
 * was fine. Duels need several — create, join, start a round, end it — and a
 * wallet popup on each would be miserable.
 *
 * What this token is: proof that whoever holds it controlled the address at
 * sign-in. What it is NOT: a session key. It cannot authorize a transaction,
 * and the verifier signature it ultimately unlocks is still bound to
 * msg.sender on chain. A leaked token costs its owner a daily round and some
 * duels. It is not custodial.
 */

export interface AuthedRequest extends Request {
  player?: string;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!raw) return res.status(401).json({ error: "not signed in" });

  const player = await store.resolveToken(raw);
  if (!player) return res.status(401).json({ error: "not signed in" });

  req.player = player;
  next();
}

export const authRouter = Router();

authRouter.get("/nonce", async (_req, res) => {
  const nonce = generateNonce();
  await store.putNonce(nonce, NONCE_TTL_MS);
  res.json({ nonce });
});

authRouter.post("/verify", async (req, res) => {
  const { message, signature } = req.body ?? {};
  if (typeof message !== "string" || typeof signature !== "string") {
    return res.status(400).json({ error: "missing message or signature" });
  }

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    return res.status(400).json({ error: "malformed SIWE message" });
  }

  // Consume before verifying. The nonce is spent either way, so a failed
  // signature cannot be retried against the same one — and consumeNonce is
  // atomic, so two concurrent requests cannot both claim it.
  if (!(await store.consumeNonce(siwe.nonce))) {
    return res.status(401).json({ error: "stale or unknown nonce" });
  }

  // SIWE_DOMAIN may list several hosts, because one site is commonly reachable
  // at both the apex and www, and the domain inside the signed message is
  // whatever host the browser was on. With a single accepted value, visiting
  // the other one fails here — and the error reads like a bad signature rather
  // than a hostname mismatch, which is miserable to debug.
  //
  // This stays strict: the message's own domain has to be one WE allow, and
  // the signature is then verified against that exact domain. An attacker
  // cannot widen it by choosing their own.
  if (!CONFIG.SIWE_DOMAINS.includes(siwe.domain)) {
    return res.status(401).json({
      error: "SIWE domain not allowed",
      got: siwe.domain,
      expected: CONFIG.SIWE_DOMAINS,
    });
  }

  try {
    const result = await siwe.verify({
      signature,
      domain: siwe.domain,
      nonce: siwe.nonce,
    });
    if (!result.success) return res.status(401).json({ error: "SIWE verification failed" });
  } catch (e: any) {
    return res
      .status(401)
      .json({ error: "SIWE verification failed", detail: String(e?.message ?? e) });
  }

  const player = ethers.getAddress(siwe.address);
  const token = ethers.hexlify(ethers.randomBytes(32));
  await store.putToken(token, player, TOKEN_TTL_MS);

  res.json({ token, player, expiresInMs: TOKEN_TTL_MS });
});

authRouter.post("/logout", async (req: AuthedRequest, res) => {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) await store.deleteToken(header.slice(7));
  res.json({ ok: true });
});
