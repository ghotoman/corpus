/**
 * Real StorageClient backed by @shelby-protocol/sdk (Node entrypoint).
 *
 * Verified against @shelby-protocol/sdk@0.3.1 type declarations:
 *   - `new ShelbyNodeClient({ network, apiKey?, rpc?, ... })`
 *   - `client.upload({ blobData: Uint8Array, signer: Account, blobName, expirationMicros }): Promise<void>`
 *   - `client.download({ account: AccountAddressInput, blobName }): Promise<ShelbyBlob>`
 *       where ShelbyBlob = { account, name, readable: ReadableStream, contentLength }
 *   - error guards: isBlobNotFoundError / isBlobExpiredError / isAccessDeniedError
 *
 * This wrapper is the ONLY place that imports the Shelby SDK, so the rest of
 * Corpus is insulated from SDK churn. It holds the Shelby signing account — it
 * must run server-side only (the backend), never in the browser.
 */
import {
  Account,
  Ed25519PrivateKey,
  Network,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
// Network the Shelby SDK actually accepts: SHELBYNET | TESTNET | LOCAL.
// The package exposes only `/node` and `/browser` entrypoints (no root export),
// so the client AND the error guards are imported from `/node`.
import {
  isBlobExpiredError,
  isBlobNotFoundError,
  ShelbyNodeClient,
  type ShelbyNetwork,
} from "@shelby-protocol/sdk/node";
import {
  BlobUnavailableError,
  type DownloadResult,
  type ReadRef,
  type StorageClient,
  type StorageHandle,
  type UploadParams,
} from "./StorageClient.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ShelbyStorageConfig {
  /** Hex Ed25519 private key for the server's Shelby/Aptos account. Required. */
  privateKey: string;
  /** Shelby/Aptos network (SHELBYNET | TESTNET | LOCAL). Defaults to SHELBYNET. */
  network?: ShelbyNetwork;
  /** Optional Shelby API key (format "AG-..."), passed through when present. */
  apiKey?: string;
  /** Default blob TTL when an upload omits `expiresAt`. */
  defaultTtlMs?: number;
}

export class ShelbyStorageClient implements StorageClient {
  private readonly client: ShelbyNodeClient;
  private readonly signer: Account;
  private readonly defaultTtlMs: number;

  constructor(config: ShelbyStorageConfig) {
    this.signer = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(
        // Accepts both AIP-80 ("ed25519-priv-0x...") and raw hex forms.
        PrivateKey.formatPrivateKey(config.privateKey, PrivateKeyVariants.Ed25519),
      ),
    });
    this.defaultTtlMs = config.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.client = new ShelbyNodeClient({
      network: config.network ?? Network.SHELBYNET,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  /** The address Corpus listings should record as `storage_account`. */
  get account(): string {
    return this.signer.accountAddress.toString();
  }

  async upload(params: UploadParams): Promise<StorageHandle> {
    const expiresAt =
      params.expiresAt ?? new Date(Date.now() + this.defaultTtlMs);
    // Shelby expects µs since epoch.
    const expirationMicros = expiresAt.getTime() * 1000;

    await this.client.upload({
      blobData: params.data,
      signer: this.signer,
      blobName: params.blobName,
      expirationMicros,
    });

    // upload() returns void; the handle is (signer address, blobName).
    return { account: this.account, blobName: params.blobName };
  }

  async getReadRef(handle: StorageHandle): Promise<ReadRef> {
    // Shelby has no signed-URL primitive: the honest read ref is the addressing
    // pair, served through this trusted backend. We surface the on-Shelby expiry
    // by probing the blob's existence is intentionally avoided (an extra RPC) —
    // callers that need expiry can read it from the on-chain listing metadata.
    return { handle };
  }

  async download(handle: StorageHandle): Promise<DownloadResult> {
    try {
      const blob = await this.client.download({
        account: handle.account,
        blobName: handle.blobName,
      });
      return {
        stream: blob.readable,
        contentLength: blob.contentLength,
        handle,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isBlobNotFoundError(message)) {
        throw new BlobUnavailableError("blob not found", handle, "not_found", {
          cause: err,
        });
      }
      if (isBlobExpiredError(message)) {
        throw new BlobUnavailableError("blob expired", handle, "expired", {
          cause: err,
        });
      }
      // RPC down, network error, etc. — fail closed; the gate maps this to 503.
      throw new BlobUnavailableError(
        `download failed: ${message}`,
        handle,
        "unavailable",
        { cause: err },
      );
    }
  }
}
