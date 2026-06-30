/**
 * Dev-keypair signer.
 *
 * shelbynet is a custom, isolated network that browser wallets (Petra, etc.)
 * don't support out of the box, so for the demo we generate/persist a local
 * Ed25519 keypair and sign with the Aptos TS SDK directly. This key lives in
 * localStorage and is for DEV ONLY.
 *
 * TODO(mainnet): replace with @aptos-labs/wallet-adapter-react so real wallets
 * sign purchases; keep this dev signer behind a flag for local testing.
 */
import { Account, Ed25519Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";

const STORAGE_KEY = "corpus.dev.privateKey";

export function loadOrCreateAccount(): Ed25519Account {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    return Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(stored),
    });
  }
  const account = Account.generate();
  localStorage.setItem(STORAGE_KEY, account.privateKey.toString());
  return account;
}

export function resetAccount(): Ed25519Account {
  localStorage.removeItem(STORAGE_KEY);
  return loadOrCreateAccount();
}
