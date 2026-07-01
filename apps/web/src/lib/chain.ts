/**
 * Client-side Aptos access: read listings from the Move view functions and
 * submit the buyer-signed `purchase` transaction. No secrets here — the dev
 * keypair signs locally and only public on-chain calls are made.
 */
import {
  Account,
  Aptos,
  AptosConfig,
  type Network,
} from "@aptos-labs/ts-sdk";
import { MODULE_ADDRESS, NETWORK } from "../config";

export interface Dataset {
  id: number;
  owner: string;
  title: string;
  description: string;
  price: string; // Octas
  createdAt: number;
  active: boolean;
}

interface RawDataset {
  id: string;
  owner: string;
  title: string;
  description: string;
  storage_account: string;
  blob_name: string;
  price: string;
  created_at: string;
  active: boolean;
}

function fn(name: string): `${string}::${string}::${string}` {
  return `${MODULE_ADDRESS}::marketplace::${name}` as `${string}::${string}::${string}`;
}

export function makeAptos(network: Network = NETWORK): Aptos {
  return new Aptos(new AptosConfig({ network }));
}

export async function listDatasets(aptos: Aptos): Promise<Dataset[]> {
  const [rows] = await aptos.view<[RawDataset[]]>({
    payload: { function: fn("list_datasets"), functionArguments: [] },
  });
  return rows.map((r) => ({
    id: Number(r.id),
    owner: r.owner,
    title: r.title,
    description: r.description,
    price: r.price,
    createdAt: Number(r.created_at),
    active: r.active,
  }));
}

export async function isEntitled(
  aptos: Aptos,
  buyer: string,
  datasetId: number,
): Promise<boolean> {
  try {
    const [ok] = await aptos.view<[boolean]>({
      payload: {
        function: fn("is_entitled"),
        functionArguments: [buyer, String(datasetId)],
      },
    });
    return ok === true;
  } catch {
    return false;
  }
}

/** Submit the buyer-signed purchase transaction and wait for it to commit. */
export async function purchase(
  aptos: Aptos,
  buyer: Account,
  datasetId: number,
): Promise<string> {
  const transaction = await aptos.transaction.build.simple({
    sender: buyer.accountAddress,
    data: {
      function: fn("purchase"),
      functionArguments: [String(datasetId)],
    },
  });
  const pending = await aptos.signAndSubmitTransaction({
    signer: buyer,
    transaction,
  });
  await aptos.waitForTransaction({ transactionHash: pending.hash });
  return pending.hash;
}

/** Fund the dev account from the shelbynet faucet (APT for gas + purchases). */
export async function fundFromFaucet(
  aptos: Aptos,
  address: string,
  amount = 100_000_000, // 1 APT
): Promise<void> {
  await aptos.fundAccount({ accountAddress: address, amount });
}

export async function aptBalance(
  aptos: Aptos,
  address: string,
): Promise<number> {
  try {
    return await aptos.getAccountAPTAmount({ accountAddress: address });
  } catch {
    return 0;
  }
}
