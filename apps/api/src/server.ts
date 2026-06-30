/**
 * Corpus backend gate.
 *
 * Responsibilities:
 *   - Serve dataset listings (public projection, no storage handle).
 *   - Issue download challenges and verify proof-of-control + on-chain
 *     entitlement before streaming Shelby bytes back through this trusted
 *     process. The Shelby signing key never leaves the server.
 *
 * It fails CLOSED: any uncertainty in the entitlement path results in denial.
 */
import { Readable } from "node:stream";
import cors from "cors";
import express from "express";
import {
  BlobUnavailableError,
  ShelbyStorageClient,
  type StorageHandle,
} from "@corpus/storage";
import { AuthError, ChallengeStore, type Proof } from "./auth.js";
import { CorpusChain, toPublic } from "./chain.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const chain = new CorpusChain(config.network, config.moduleAddress);
const storage = new ShelbyStorageClient({
  privateKey: config.shelbyPrivateKey,
  network: config.network,
  apiKey: config.shelbyApiKey,
});
const challenges = new ChallengeStore();

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: config.corsOrigins.length ? config.corsOrigins : true,
  }),
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, network: config.network, module: config.moduleAddress });
});

// All datasets (public projection).
app.get("/api/datasets", async (_req, res) => {
  try {
    const datasets = await chain.listDatasets();
    res.json(datasets.map(toPublic));
  } catch (err) {
    res.status(502).json({ error: `failed to read listings: ${msg(err)}` });
  }
});

// One dataset.
app.get("/api/datasets/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 0)
    return res.status(400).json({ error: "invalid dataset id" });
  try {
    const dataset = await chain.getDataset(id);
    res.json(toPublic(dataset));
  } catch {
    res.status(404).json({ error: "dataset not found" });
  }
});

// Step 1 of download: get a single-use challenge to sign.
app.post("/api/auth/challenge", (req, res) => {
  const address = req.body?.address;
  if (typeof address !== "string" || !address)
    return res.status(400).json({ error: "address required" });
  try {
    res.json(challenges.issue(address));
  } catch {
    res.status(400).json({ error: "invalid address" });
  }
});

// Step 2: prove control + entitlement, then stream the blob.
app.post("/api/datasets/:id/download", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 0)
    return res.status(400).json({ error: "invalid dataset id" });

  const proof = req.body as Partial<Proof>;
  if (
    !proof?.address ||
    !proof.publicKey ||
    !proof.nonce ||
    !proof.signature
  ) {
    return res
      .status(400)
      .json({ error: "address, publicKey, nonce, signature required" });
  }

  // Verify the requester controls the claimed buyer address.
  let buyer: string;
  try {
    buyer = challenges.verify(proof as Proof);
  } catch (err) {
    if (err instanceof AuthError)
      return res.status(err.status).json({ error: err.message });
    return res.status(401).json({ error: "authorization failed" });
  }

  // Verify the entitlement on-chain (fails closed).
  const entitled = await chain.isEntitled(buyer, id);
  if (!entitled)
    return res
      .status(403)
      .json({ error: "not entitled — purchase this dataset first" });

  // Resolve the storage handle from the listing and stream bytes.
  let handle: StorageHandle;
  try {
    const dataset = await chain.getDataset(id);
    handle = { account: dataset.storageAccount, blobName: dataset.blobName };
  } catch {
    return res.status(404).json({ error: "dataset not found" });
  }

  try {
    const { stream, contentLength } = await storage.download(handle);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(contentLength));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename(handle.blobName)}"`,
    );
    // Web ReadableStream -> Node stream -> response.
    Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } catch (err) {
    if (err instanceof BlobUnavailableError) {
      const status =
        err.reason === "not_found" ? 404 : err.reason === "expired" ? 410 : 503;
      return res.status(status).json({ error: err.message, reason: err.reason });
    }
    return res.status(500).json({ error: `download failed: ${msg(err)}` });
  }
});

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeFilename(blobName: string): string {
  return blobName.replace(/[^a-zA-Z0-9._-]/g, "_") || "dataset.bin";
}

app.listen(config.port, () => {
  console.log(
    `[corpus] gate listening on :${config.port} ` +
      `(network=${config.network}, module=${config.moduleAddress})`,
  );
});
