import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ed25519Account } from "@aptos-labs/ts-sdk";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { MODULE_ADDRESS, NETWORK, WALLET_ENABLED } from "./config";
import { downloadDataset, saveBlob } from "./lib/api";
import {
  aptBalance,
  fundFromFaucet,
  isEntitled,
  listDatasets,
  makeAptos,
  type Dataset,
} from "./lib/chain";
import { makeDevSigner, makeWalletSigner } from "./lib/signer";
import { loadOrCreateAccount, resetAccount } from "./lib/wallet";

const OCTAS = 100_000_000;
const fmtApt = (octas: string) => `${(Number(octas) / OCTAS).toFixed(4)} APT`;
const short = (addr: string) =>
  addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

export function App() {
  const aptos = useMemo(() => makeAptos(), []);
  const wallet = useWallet();
  const [devAccount, setDevAccount] = useState<Ed25519Account>(() =>
    loadOrCreateAccount(),
  );

  // The active signer: a connected wallet (when the flag is on) wins,
  // otherwise the dev keypair. All purchases/downloads go through it.
  const signer = useMemo(() => {
    if (WALLET_ENABLED) {
      const walletSigner = makeWalletSigner(wallet, aptos);
      if (walletSigner) return walletSigner;
    }
    return makeDevSigner(devAccount, aptos);
  }, [wallet, devAccount, aptos]);
  const address = signer.address;

  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [owned, setOwned] = useState<Record<number, boolean>>({});
  const [balance, setBalance] = useState<number>(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const list = await listDatasets(aptos);
      setDatasets(list);
      const entitlements = await Promise.all(
        list.map((d) => isEntitled(aptos, address, d.id)),
      );
      setOwned(Object.fromEntries(list.map((d, i) => [d.id, entitlements[i]])));
      setBalance(await aptBalance(aptos, address));
    } catch (e) {
      setError(
        `Could not load listings. Is the contract deployed at ${
          MODULE_ADDRESS || "(unset VITE_CORPUS_MODULE_ADDRESS)"
        }? ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [aptos, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    setStatus("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onFund = () =>
    run("fund", async () => {
      await fundFromFaucet(aptos, address);
      setStatus("Funded from faucet.");
      await refresh();
    });

  const onPurchase = (d: Dataset) =>
    run(`buy-${d.id}`, async () => {
      const hash = await signer.purchase(d.id);
      setStatus(`Purchased "${d.title}" (tx ${short(hash)}).`);
      await refresh();
    });

  const onDownload = (d: Dataset) =>
    run(`dl-${d.id}`, async () => {
      const file = await downloadDataset(signer, d.id);
      saveBlob(file);
      setStatus(`Downloaded ${file.filename}.`);
    });

  const onNewAccount = () => {
    setDevAccount(resetAccount());
    setStatus("Generated a fresh dev account.");
  };

  const onConnect = (walletName: string) =>
    run("connect", async () => {
      wallet.connect(walletName);
    });

  return (
    <div className="page">
      <header>
        <h1>Corpus</h1>
        <p className="tagline">
          A marketplace for AI datasets — storage on Shelby, access enforced on
          Aptos.
        </p>
      </header>

      {WALLET_ENABLED && (
        <section className="wallet card">
          <div className="wallet-row">
            <div>
              <div className="label">Wallet</div>
              {wallet.connected && wallet.account ? (
                <code title={wallet.account.address.toString()}>
                  {wallet.wallet?.name}: {short(wallet.account.address.toString())}
                </code>
              ) : (
                <span className="muted">not connected</span>
              )}
            </div>
            <div className="wallet-actions">
              {wallet.connected ? (
                <button className="ghost" onClick={() => wallet.disconnect()}>
                  Disconnect
                </button>
              ) : (
                wallet.wallets.map((w) => (
                  <button
                    key={w.name}
                    onClick={() => onConnect(w.name)}
                    disabled={busy === "connect"}
                  >
                    Connect {w.name}
                  </button>
                ))
              )}
            </div>
          </div>
          <p className="warn">
            Wallet mode: your wallet must be on the {NETWORK} network. Only
            Ed25519 wallet accounts can pass the download gate (keyless /
            multi-key accounts are denied).
          </p>
        </section>
      )}

      <section className="wallet card">
        <div className="wallet-row">
          <div>
            <div className="label">
              {signer.kind === "wallet"
                ? `Active signer: wallet (${NETWORK})`
                : `Dev account (${NETWORK})`}
            </div>
            <code title={address}>{short(address)}</code>
          </div>
          <div>
            <div className="label">Balance</div>
            <code>{(balance / OCTAS).toFixed(4)} APT</code>
          </div>
          <div className="wallet-actions">
            <button onClick={onFund} disabled={busy === "fund"}>
              {busy === "fund" ? "Funding…" : "Fund (faucet)"}
            </button>
            {signer.kind === "dev" && (
              <button className="ghost" onClick={onNewAccount}>
                New account
              </button>
            )}
            <button className="ghost" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        </div>
        {signer.kind === "dev" && (
          <p className="warn">
            Dev keypair stored in your browser (localStorage). For demo use only
            — not a real wallet.
          </p>
        )}
      </section>

      {status && <div className="banner ok">{status}</div>}
      {error && <div className="banner err">{error}</div>}

      <section className="grid">
        {datasets.length === 0 && !error && (
          <p className="muted">No datasets listed yet. Run the seed script.</p>
        )}
        {datasets.map((d) => {
          const isOwned = owned[d.id];
          return (
            <article key={d.id} className={`card dataset${d.active ? "" : " inactive"}`}>
              <h3>{d.title}</h3>
              <p className="desc">{d.description}</p>
              <div className="meta">
                <span>by {short(d.owner)}</span>
                <span className="price">{fmtApt(d.price)}</span>
              </div>
              <div className="actions">
                {isOwned ? (
                  <>
                    <span className="badge">Owned</span>
                    <button
                      onClick={() => onDownload(d)}
                      disabled={busy === `dl-${d.id}`}
                    >
                      {busy === `dl-${d.id}` ? "Downloading…" : "Download"}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => onPurchase(d)}
                    disabled={!d.active || busy === `buy-${d.id}`}
                  >
                    {busy === `buy-${d.id}`
                      ? "Purchasing…"
                      : d.active
                        ? `Buy for ${fmtApt(d.price)}`
                        : "Delisted"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>

      <footer>
        <span>Module: <code>{short(MODULE_ADDRESS || "unset")}</code></span>
      </footer>
    </div>
  );
}
