/**
 * Thin wrapper over the Aptos TS SDK for reading the Corpus Move contract.
 * All reads go through `aptos.view(...)` against the marketplace module.
 */
import { Aptos, AptosConfig, type Network } from "@aptos-labs/ts-sdk";

/** A dataset as returned by the `list_datasets` / `get_dataset` views. */
export interface Dataset {
  id: number;
  owner: string;
  title: string;
  description: string;
  /** Shelby read reference (uploader account + blob name). Server-side only. */
  storageAccount: string;
  blobName: string;
  /** Price in Octas (APT smallest unit), as a string to avoid precision loss. */
  price: string;
  createdAt: number;
  active: boolean;
}

/** Public projection — what we expose to the browser (no storage handle). */
export type PublicDataset = Omit<Dataset, "storageAccount" | "blobName">;

export function toPublic(d: Dataset): PublicDataset {
  const { storageAccount: _a, blobName: _b, ...rest } = d;
  return rest;
}

// Raw shape Move returns for a DatasetView (u64 -> string, address -> hex).
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

function normalize(raw: RawDataset): Dataset {
  return {
    id: Number(raw.id),
    owner: raw.owner,
    title: raw.title,
    description: raw.description,
    storageAccount: raw.storage_account,
    blobName: raw.blob_name,
    price: raw.price,
    createdAt: Number(raw.created_at),
    active: raw.active,
  };
}

export class CorpusChain {
  private readonly aptos: Aptos;
  private readonly module: string;

  constructor(network: Network, moduleAddress: string) {
    this.aptos = new Aptos(new AptosConfig({ network }));
    this.module = `${moduleAddress}::marketplace`;
  }

  /** Build a fully-qualified Move function id (`addr::module::name`). */
  private fn(name: string): `${string}::${string}::${string}` {
    return `${this.module}::${name}` as `${string}::${string}::${string}`;
  }

  async listDatasets(): Promise<Dataset[]> {
    const [rows] = await this.aptos.view<[RawDataset[]]>({
      payload: { function: this.fn("list_datasets"), functionArguments: [] },
    });
    return rows.map(normalize);
  }

  async getDataset(id: number): Promise<Dataset> {
    const [row] = await this.aptos.view<[RawDataset]>({
      payload: {
        function: this.fn("get_dataset"),
        functionArguments: [String(id)],
      },
    });
    return normalize(row);
  }

  /**
   * On-chain entitlement check. Fails CLOSED: any view error (RPC down, bad
   * input) returns false so the gate denies on doubt rather than leaking data.
   */
  async isEntitled(buyer: string, datasetId: number): Promise<boolean> {
    try {
      const [entitled] = await this.aptos.view<[boolean]>({
        payload: {
          function: this.fn("is_entitled"),
          functionArguments: [buyer, String(datasetId)],
        },
      });
      return entitled === true;
    } catch {
      return false;
    }
  }
}
