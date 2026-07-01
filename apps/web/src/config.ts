import { Network } from "@aptos-labs/ts-sdk";

function network(): Network {
  switch ((import.meta.env.VITE_CORPUS_NETWORK ?? "shelbynet").toLowerCase()) {
    case "testnet":
      return Network.TESTNET;
    case "local":
      return Network.LOCAL;
    default:
      return Network.SHELBYNET;
  }
}

export const NETWORK = network();
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string) ?? "http://localhost:8787";
export const MODULE_ADDRESS =
  (import.meta.env.VITE_CORPUS_MODULE_ADDRESS as string) ?? "";
