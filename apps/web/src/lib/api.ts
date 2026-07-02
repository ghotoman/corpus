/**
 * Backend client for the gated download. The browser never sees Shelby
 * credentials: the active signer (dev keypair or wallet) proves control of the
 * buyer address by signing a single-use challenge, and the backend (which
 * holds the Shelby key) streams the bytes back only after verifying that
 * proof + the on-chain entitlement.
 */
import { API_BASE } from "../config";
import type { CorpusSigner } from "./signer";

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

export async function downloadDataset(
  signer: CorpusSigner,
  datasetId: number,
): Promise<DownloadedFile> {
  // 1. Ask for a single-use challenge bound to this address.
  const challengeRes = await fetch(`${API_BASE}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: signer.address }),
  });
  if (!challengeRes.ok) throw new Error(await errorText(challengeRes));
  const { nonce } = (await challengeRes.json()) as { nonce: string };

  // 2. Sign it (raw bytes for the dev key, AIP-62 envelope for wallets).
  const proof = await signer.proveControl(nonce);

  // 3. Submit the proof; backend verifies + entitlement-gates, then streams.
  const res = await fetch(`${API_BASE}/api/datasets/${datasetId}/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proof),
  });
  if (!res.ok) throw new Error(await errorText(res));

  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? `dataset-${datasetId}.bin`;
  return { blob: await res.blob(), filename };
}

/** Trigger a browser file save for a downloaded blob. */
export function saveBlob(file: DownloadedFile): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
