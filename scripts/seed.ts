/**
 * One-command re-seed for a wiped shelbynet.
 *
 *   npm run seed
 *
 * Does everything needed to get a working demo from a fresh/wiped environment:
 *   1. Fund the operator account (APT for gas, ShelbyUSD for storage).
 *   2. Publish the Move contract if it isn't already published.
 *   3. Upload a small sample dataset to Shelby.
 *   4. Create an on-chain listing pointing at the fresh storage handle.
 *
 * Requires .env (SHELBY_PRIVATE_KEY, CORPUS_NETWORK) and the `aptos` CLI on PATH.
 */
import { ShelbyStorageClient } from "@corpus/storage";
import {
  isModulePublished,
  makeAptos,
  moduleFunction,
  networkFromEnv,
  operatorAccount,
  publishMove,
  requireEnv,
} from "./lib.js";

// A tiny sample "dataset" (JSONL). Keep it small — devnet is single-RPC.
const SAMPLE_ROWS = [
  { prompt: "Translate to French: good morning", completion: "bonjour" },
  { prompt: "Capital of Japan?", completion: "Tokyo" },
  { prompt: "2 + 2 =", completion: "4" },
  { prompt: "Antonym of 'hot'", completion: "cold" },
];
const SAMPLE = SAMPLE_ROWS.map((r) => JSON.stringify(r)).join("\n");

const PRICE_OCTAS = 1_000_000; // 0.01 APT

async function main() {
  const network = networkFromEnv();
  const operator = operatorAccount();
  const address = operator.accountAddress.toStringLong();
  const privateKey = requireEnv("SHELBY_PRIVATE_KEY");
  const aptos = makeAptos(network);

  console.log(`[seed] operator ${address} on ${network}`);

  // 1. Fund: APT (gas + listing) + ShelbyUSD (storage).
  const storage = new ShelbyStorageClient({
    privateKey,
    network,
    apiKey: process.env.SHELBY_API_KEY || undefined,
  });
  try {
    await aptos.fundAccount({ accountAddress: address, amount: 100_000_000 });
    console.log("[seed] funded APT from faucet");
  } catch (e) {
    console.warn(`[seed] APT faucet warn: ${asMsg(e)}`);
  }
  try {
    await storage.fundShelbyUSD(100_000_000);
    console.log("[seed] funded ShelbyUSD for storage");
  } catch (e) {
    console.warn(`[seed] ShelbyUSD faucet warn: ${asMsg(e)}`);
  }

  // 2. Publish the contract if needed.
  if (await isModulePublished(aptos, address)) {
    console.log("[seed] marketplace already published");
  } else {
    publishMove(network, privateKey, address);
  }

  // 3. Upload the sample dataset to Shelby. Unique name per run so re-seeding a
  //    non-wiped env doesn't collide with an existing (unexpired) blob.
  const blobName = `corpus/sample-${Date.now()}.jsonl`;
  const expiresAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000); // 6 days
  const handle = await storage.upload({
    data: new TextEncoder().encode(SAMPLE),
    blobName,
    expiresAt,
  });
  console.log(`[seed] uploaded blob ${handle.account}/${handle.blobName}`);

  // 4. List it on-chain.
  const tx = await aptos.transaction.build.simple({
    sender: operator.accountAddress,
    data: {
      function: moduleFunction(address, "list_dataset"),
      functionArguments: [
        "QA Pairs (sample)",
        "A tiny instruction/response dataset for demoing Corpus.",
        handle.account,
        handle.blobName,
        String(PRICE_OCTAS),
      ],
    },
  });
  const pending = await aptos.signAndSubmitTransaction({
    signer: operator,
    transaction: tx,
  });
  await aptos.waitForTransaction({ transactionHash: pending.hash });
  console.log(`[seed] listed dataset (tx ${pending.hash})`);

  console.log("\n[seed] done. Ensure your .env has:");
  console.log(`  CORPUS_MODULE_ADDRESS=${address}`);
  console.log(`  VITE_CORPUS_MODULE_ADDRESS=${address}`);
  console.log("Then: npm run api   (terminal 1)   and   npm run web   (terminal 2)");
}

function asMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
