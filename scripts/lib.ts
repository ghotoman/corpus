/**
 * Shared helpers for the deploy + seed scripts. These run in Node with full
 * network access (NOT in the browser) and use the operator's Shelby/Aptos key.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..");
export const MOVE_DIR = resolve(REPO_ROOT, "move");
dotenv.config({ path: resolve(REPO_ROOT, ".env") });

export type SupportedNetwork =
  | Network.SHELBYNET
  | Network.TESTNET
  | Network.LOCAL;

// REST fullnode URLs, verified from @aptos-labs/ts-sdk's apiEndpoints for each
// network. Passed to the `aptos` CLI for `move publish`.
const REST_URL: Record<SupportedNetwork, string> = {
  [Network.SHELBYNET]: "https://api.shelbynet.shelby.xyz/v1",
  [Network.TESTNET]: "https://api.testnet.aptoslabs.com/v1",
  [Network.LOCAL]: "http://localhost:8080/v1",
};

export function networkFromEnv(): SupportedNetwork {
  switch ((process.env.CORPUS_NETWORK ?? "shelbynet").toLowerCase()) {
    case "testnet":
      return Network.TESTNET;
    case "local":
      return Network.LOCAL;
    case "shelbynet":
      return Network.SHELBYNET;
    default:
      throw new Error(`Unsupported CORPUS_NETWORK "${process.env.CORPUS_NETWORK}"`);
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

export function operatorAccount(): Account {
  const formatted = PrivateKey.formatPrivateKey(
    requireEnv("SHELBY_PRIVATE_KEY"),
    PrivateKeyVariants.Ed25519,
  );
  return Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(formatted),
  });
}

export function makeAptos(network: SupportedNetwork): Aptos {
  return new Aptos(new AptosConfig({ network }));
}

export function moduleFunction(
  moduleAddress: string,
  name: string,
): `${string}::${string}::${string}` {
  return `${moduleAddress}::marketplace::${name}` as `${string}::${string}::${string}`;
}

/** True if the marketplace module is already published under `address`. */
export async function isModulePublished(
  aptos: Aptos,
  address: string,
): Promise<boolean> {
  try {
    await aptos.getAccountModule({
      accountAddress: address,
      moduleName: "marketplace",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Publish (or re-publish) the Move package under the operator address by
 * shelling out to the `aptos` CLI — the standard, reproducible publish path.
 * Requires the `aptos` CLI on PATH (see README prerequisites).
 */
export function publishMove(
  network: SupportedNetwork,
  privateKey: string,
  moduleAddress: string,
): void {
  const formatted = PrivateKey.formatPrivateKey(
    privateKey,
    PrivateKeyVariants.Ed25519,
  );
  console.log(`[deploy] publishing marketplace to ${moduleAddress} (${network})`);
  execFileSync(
    "aptos",
    [
      "move",
      "publish",
      "--package-dir",
      MOVE_DIR,
      "--named-addresses",
      `corpus=${moduleAddress}`,
      "--private-key",
      formatted,
      "--url",
      REST_URL[network],
      "--assume-yes",
    ],
    { stdio: "inherit" },
  );
}
