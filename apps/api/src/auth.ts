/**
 * Proof-of-control for downloads.
 *
 * The on-chain entitlement (`is_entitled(buyer, id)`) is public, so checking it
 * alone would let anyone download a dataset by passing *someone else's* buyer
 * address. To gate honestly we require the requester to prove they control the
 * buyer address by signing a server-issued, single-use challenge. Only then do
 * we check entitlement and stream bytes.
 *
 * This is a demo-grade challenge store (in-memory, single process). For
 * production, back it with a shared store (Redis) and add rate limiting.
 */
import {
  AccountAddress,
  Ed25519PublicKey,
  Ed25519Signature,
} from "@aptos-labs/ts-sdk";
import { randomBytes } from "node:crypto";

const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes

interface Challenge {
  address: string; // normalized long form
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface Proof {
  address: string;
  publicKey: string;
  nonce: string;
  signature: string;
}

/** The exact bytes the client must sign for a given nonce. */
export function challengeMessage(nonce: string): Uint8Array {
  return new TextEncoder().encode(
    `Corpus download authorization\nnonce: ${nonce}`,
  );
}

export class ChallengeStore {
  private readonly challenges = new Map<string, Challenge>();

  private normalize(address: string): string {
    return AccountAddress.from(address).toStringLong();
  }

  /** Issue a single-use challenge bound to `address`. */
  issue(address: string): { nonce: string; expiresAt: number } {
    const normalized = this.normalize(address);
    const nonce = `0x${randomBytes(24).toString("hex")}`;
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    this.challenges.set(nonce, { address: normalized, expiresAt });
    this.sweep();
    return { nonce, expiresAt };
  }

  /**
   * Verify a proof. Returns the normalized address on success; throws AuthError
   * otherwise. Consumes the nonce (one-time use) on any matched lookup.
   */
  verify(proof: Proof): string {
    const challenge = this.challenges.get(proof.nonce);
    // Always consume a matched nonce so it can't be replayed.
    if (challenge) this.challenges.delete(proof.nonce);

    if (!challenge) throw new AuthError("unknown or used challenge", 401);
    if (challenge.expiresAt < Date.now())
      throw new AuthError("challenge expired", 401);

    const claimed = this.normalize(proof.address);
    if (claimed !== challenge.address)
      throw new AuthError("challenge/address mismatch", 401);

    // The public key must hash to the claimed address.
    let derived: string;
    let valid: boolean;
    try {
      const pk = new Ed25519PublicKey(proof.publicKey);
      derived = pk.authKey().derivedAddress().toStringLong();
      valid = pk.verifySignature({
        message: challengeMessage(proof.nonce),
        signature: new Ed25519Signature(proof.signature),
      });
    } catch (err) {
      throw new AuthError(
        `invalid key/signature encoding: ${
          err instanceof Error ? err.message : String(err)
        }`,
        400,
      );
    }

    if (derived !== claimed)
      throw new AuthError("public key does not match address", 401);
    if (!valid) throw new AuthError("bad signature", 401);

    return claimed;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [nonce, c] of this.challenges) {
      if (c.expiresAt < now) this.challenges.delete(nonce);
    }
  }
}
