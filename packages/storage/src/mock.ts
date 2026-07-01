/**
 * In-memory StorageClient for tests and offline dev. No network, no Shelby, no
 * Aptos. Mimics the parts of Shelby's behaviour Corpus relies on:
 *   - reads are addressed by (account, blobName)
 *   - blobs expire; reading an expired blob throws BlobUnavailableError("expired")
 *   - reading an unknown blob throws BlobUnavailableError("not_found")
 */
import {
  BlobUnavailableError,
  type DownloadResult,
  type ReadRef,
  type StorageClient,
  type StorageHandle,
  type UploadParams,
} from "./StorageClient.js";

interface StoredBlob {
  data: Uint8Array;
  expiresAt: Date;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, like a weekly devnet

export interface MockStorageOptions {
  /** Account address all uploads are attributed to. Defaults to "0xmock". */
  account?: string;
  /** Override "now" for deterministic expiry tests. */
  now?: () => Date;
}

export class MockStorageClient implements StorageClient {
  private readonly blobs = new Map<string, StoredBlob>();
  private readonly account: string;
  private readonly now: () => Date;

  constructor(options: MockStorageOptions = {}) {
    this.account = options.account ?? "0xmock";
    this.now = options.now ?? (() => new Date());
  }

  private key(account: string, blobName: string): string {
    return `${account}::${blobName}`;
  }

  async upload(params: UploadParams): Promise<StorageHandle> {
    const expiresAt =
      params.expiresAt ?? new Date(this.now().getTime() + DEFAULT_TTL_MS);
    this.blobs.set(this.key(this.account, params.blobName), {
      data: params.data,
      expiresAt,
    });
    return { account: this.account, blobName: params.blobName };
  }

  async getReadRef(handle: StorageHandle): Promise<ReadRef> {
    const blob = this.blobs.get(this.key(handle.account, handle.blobName));
    if (!blob) {
      throw new BlobUnavailableError("blob not found", handle, "not_found");
    }
    return { handle, expiresAt: blob.expiresAt };
  }

  async download(handle: StorageHandle): Promise<DownloadResult> {
    const blob = this.blobs.get(this.key(handle.account, handle.blobName));
    if (!blob) {
      throw new BlobUnavailableError("blob not found", handle, "not_found");
    }
    if (blob.expiresAt.getTime() <= this.now().getTime()) {
      throw new BlobUnavailableError("blob expired", handle, "expired");
    }
    const bytes = blob.data;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { stream, contentLength: bytes.byteLength, handle };
  }
}
