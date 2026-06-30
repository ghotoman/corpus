/**
 * StorageClient — the storage abstraction Corpus depends on.
 *
 * The app is deliberately decoupled from `@shelby-protocol/sdk`: everything
 * upstream (backend gate, seed script) talks to this interface, and we swap in
 * either the real Shelby adapter (`shelby.ts`) or the in-memory mock
 * (`mock.ts`) for tests / offline dev.
 *
 * Why the handle is `{ account, blobName }`:
 *   Shelby's `ShelbyClient.upload()` returns `void` — there is no server-minted
 *   id. A blob is addressed for reads by the pair (uploader account address,
 *   blobName), and `createBlobKey({account, blobName})` -> "0x1.foo/bar" is just
 *   a string encoding of that pair. So the canonical handle in Corpus is exactly
 *   that pair, and it is what the Move contract persists per listing
 *   (`storage_account` + `blob_name`).
 */

/** The durable reference to a stored blob. Persisted on-chain per listing. */
export interface StorageHandle {
  /** Aptos account address (hex string, e.g. "0x1") the blob was uploaded under. */
  account: string;
  /** Blob name/path under `account`, e.g. "corpus/42.jsonl". */
  blobName: string;
}

/** Bytes to upload plus the metadata Shelby needs (a name and an expiry). */
export interface UploadParams {
  data: Uint8Array;
  /**
   * Blob name/path. The caller picks this (Corpus uses "corpus/<dataset>.<ext>").
   * Must satisfy Shelby's BlobNameSchema (non-empty path-like string).
   */
  blobName: string;
  /**
   * Absolute expiry. Shelby uploads always expire; the adapter converts this to
   * `expirationMicros`. Defaults are applied by the impl if omitted.
   */
  expiresAt?: Date;
}

/** Result of a download: a stream plus enough to set response headers. */
export interface DownloadResult {
  stream: ReadableStream<Uint8Array>;
  /** Total length in bytes, from Shelby's `ShelbyBlob.contentLength`. */
  contentLength: number;
  /** Echoed back for convenience (the handle that produced this stream). */
  handle: StorageHandle;
}

/**
 * A short-lived read reference. Shelby has no signed-URL primitive today, so the
 * "ref" we can honestly hand back is the addressing pair itself; reads are still
 * proxied through the trusted backend (which holds the Shelby credentials). The
 * `expiresAt` mirrors the blob's on-Shelby expiry. If Shelby later ships signed
 * URLs / capability tokens, this is the type that gains a `url` field.
 */
export interface ReadRef {
  handle: StorageHandle;
  expiresAt?: Date;
}

/** Thrown when a blob is missing or expired on the backing store. */
export class BlobUnavailableError extends Error {
  constructor(
    message: string,
    readonly handle: StorageHandle,
    readonly reason: "not_found" | "expired" | "unavailable" = "unavailable",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BlobUnavailableError";
  }
}

export interface StorageClient {
  /**
   * Upload bytes and return the durable handle. For Shelby this signs+pays with
   * the server-held account and registers the blob on-chain; the returned handle
   * is `{ account: <signer addr>, blobName }`.
   */
  upload(params: UploadParams): Promise<StorageHandle>;

  /**
   * Produce a short-lived read reference for a handle. Cheap/no-op for the
   * proxy model (returns the handle + expiry); exists so callers don't bake in
   * the assumption that reads always flow through `download()`.
   */
  getReadRef(handle: StorageHandle): Promise<ReadRef>;

  /**
   * Stream the blob's bytes. Throws `BlobUnavailableError` (reason "not_found" /
   * "expired") so the gate can map it to a 404/410 instead of a 500.
   */
  download(handle: StorageHandle): Promise<DownloadResult>;
}
