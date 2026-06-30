import assert from "node:assert/strict";
import { test } from "node:test";
import { BlobUnavailableError, MockStorageClient } from "../src/index.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

test("upload then download round-trips bytes", async () => {
  const store = new MockStorageClient();
  const data = new TextEncoder().encode("hello corpus");
  const handle = await store.upload({ data, blobName: "corpus/1.txt" });
  assert.equal(handle.blobName, "corpus/1.txt");

  const { stream, contentLength } = await store.download(handle);
  const out = await readAll(stream);
  assert.equal(contentLength, data.byteLength);
  assert.equal(new TextDecoder().decode(out), "hello corpus");
});

test("download of unknown blob throws not_found", async () => {
  const store = new MockStorageClient();
  await assert.rejects(
    () => store.download({ account: "0xmock", blobName: "nope" }),
    (e: unknown) =>
      e instanceof BlobUnavailableError && e.reason === "not_found",
  );
});

test("expired blob throws expired", async () => {
  let now = new Date("2026-01-01T00:00:00Z");
  const store = new MockStorageClient({ now: () => now });
  const handle = await store.upload({
    data: new Uint8Array([1, 2, 3]),
    blobName: "corpus/exp.bin",
    expiresAt: new Date("2026-01-02T00:00:00Z"),
  });
  now = new Date("2026-01-03T00:00:00Z"); // advance past expiry
  await assert.rejects(
    () => store.download(handle),
    (e: unknown) => e instanceof BlobUnavailableError && e.reason === "expired",
  );
});
