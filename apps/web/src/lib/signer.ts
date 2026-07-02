/**
 * CorpusSigner — the one interface the UI uses to sign things, so the app
 * doesn't care whether a dev keypair or a real wallet is behind it.
 *
 * Two implementations:
 *  - dev: the localStorage Ed25519 keypair (works on shelbynet today).
 *  - wallet: @aptos-labs/wallet-adapter-react (behind VITE_ENABLE_WALLET).
 *    Wallets can't sign raw bytes; they implement AIP-62 signMessage, which
 *    wraps our statement+nonce in a "fullMessage" envelope. The backend
 *    verifies that envelope under the "aip62" proof scheme.
 */
import type { Aptos, Ed25519Account } from "@aptos-labs/ts-sdk";
import type { WalletContextState } from "@aptos-labs/wallet-adapter-react";
import { MODULE_ADDRESS } from "../config";
import { purchase as devPurchase } from "./chain";

/** Must match CHALLENGE_STATEMENT in apps/api/src/auth.ts. */
export const CHALLENGE_STATEMENT = "Corpus download authorization";

export interface ChallengeProof {
  address: string;
  publicKey: string;
  nonce: string;
  signature: string;
  scheme: "raw" | "aip62";
  fullMessage?: string;
}

export interface CorpusSigner {
  kind: "dev" | "wallet";
  address: string;
  /** Sign + submit the purchase transaction; resolves to the committed tx hash. */
  purchase(datasetId: number): Promise<string>;
  /** Prove control of `address` for the backend download gate. */
  proveControl(nonce: string): Promise<ChallengeProof>;
}

export function makeDevSigner(
  account: Ed25519Account,
  aptos: Aptos,
): CorpusSigner {
  return {
    kind: "dev",
    address: account.accountAddress.toString(),
    purchase: (datasetId) => devPurchase(aptos, account, datasetId),
    async proveControl(nonce) {
      const message = new TextEncoder().encode(
        `${CHALLENGE_STATEMENT}\nnonce: ${nonce}`,
      );
      return {
        address: account.accountAddress.toString(),
        publicKey: account.publicKey.toString(),
        nonce,
        signature: account.sign(message).toString(),
        scheme: "raw",
      };
    },
  };
}

/**
 * Wallet-backed signer. Returns null until a wallet is connected.
 *
 * Caveats (documented, fail-closed on the backend):
 *  - Only legacy Ed25519 wallet accounts can pass the download gate; keyless /
 *    multi-key accounts are denied because the backend derives the address
 *    from the Ed25519 public key.
 *  - The wallet must be on the same network as the app (wallets don't know
 *    shelbynet; this path is for testnet/mainnet).
 */
export function makeWalletSigner(
  wallet: WalletContextState,
  aptos: Aptos,
): CorpusSigner | null {
  const account = wallet.account;
  if (!wallet.connected || !account) return null;
  const address = account.address.toString();

  return {
    kind: "wallet",
    address,
    async purchase(datasetId) {
      const out = await wallet.signAndSubmitTransaction({
        data: {
          function: `${MODULE_ADDRESS}::marketplace::purchase`,
          functionArguments: [String(datasetId)],
        },
      });
      await aptos.waitForTransaction({ transactionHash: out.hash });
      return out.hash;
    },
    async proveControl(nonce) {
      const out = await wallet.signMessage({
        message: CHALLENGE_STATEMENT,
        nonce,
      });
      return {
        address,
        publicKey: account.publicKey.toString(),
        nonce,
        signature: out.signature.toString(),
        scheme: "aip62",
        fullMessage: out.fullMessage,
      };
    },
  };
}
