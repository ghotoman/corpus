import { Network } from "@aptos-labs/ts-sdk";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Load .env from the repo root regardless of where the process starts.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "../../../.env") });

/** The networks both the Shelby SDK and our chain client accept. */
export type SupportedNetwork =
  | Network.SHELBYNET
  | Network.TESTNET
  | Network.LOCAL;

function networkFromEnv(value: string | undefined): SupportedNetwork {
  switch ((value ?? "shelbynet").toLowerCase()) {
    case "shelbynet":
      return Network.SHELBYNET;
    case "testnet":
      return Network.TESTNET;
    case "local":
      return Network.LOCAL;
    default:
      throw new Error(
        `Unsupported CORPUS_NETWORK "${value}" (expected shelbynet | testnet | local)`,
      );
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return v;
}

export interface Config {
  network: SupportedNetwork;
  moduleAddress: string;
  shelbyPrivateKey: string;
  shelbyApiKey?: string;
  port: number;
  corsOrigins: string[];
}

export function loadConfig(): Config {
  return {
    network: networkFromEnv(process.env.CORPUS_NETWORK),
    moduleAddress: required("CORPUS_MODULE_ADDRESS"),
    shelbyPrivateKey: required("SHELBY_PRIVATE_KEY"),
    shelbyApiKey: process.env.SHELBY_API_KEY || undefined,
    port: Number(process.env.PORT ?? 8787),
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
