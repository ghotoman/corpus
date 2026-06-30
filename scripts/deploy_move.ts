/**
 * Publish the Corpus Move package under the operator account.
 *
 *   npm run deploy:move
 *
 * The module address == the operator account address. Prints it so you can set
 * CORPUS_MODULE_ADDRESS / VITE_CORPUS_MODULE_ADDRESS in .env.
 */
import {
  makeAptos,
  networkFromEnv,
  operatorAccount,
  publishMove,
  requireEnv,
} from "./lib.js";

async function main() {
  const network = networkFromEnv();
  const operator = operatorAccount();
  const address = operator.accountAddress.toStringLong();
  const privateKey = requireEnv("SHELBY_PRIVATE_KEY");

  // Ensure the operator exists/funded enough to pay for publish gas.
  const aptos = makeAptos(network);
  try {
    await aptos.fundAccount({ accountAddress: address, amount: 100_000_000 });
  } catch (e) {
    console.warn(
      `[deploy] faucet fund failed (continuing; account may already be funded): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  publishMove(network, privateKey, address);

  console.log("\n[deploy] done. Set these in your .env:");
  console.log(`  CORPUS_MODULE_ADDRESS=${address}`);
  console.log(`  VITE_CORPUS_MODULE_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
