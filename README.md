# Corpus

A marketplace for **AI datasets** where the bytes live on **[Shelby](https://docs.shelby.xyz/)**
(decentralized hot storage) and listings, pricing, and access entitlements are
enforced **on-chain on Aptos (Move)**.

- **Browse** datasets pulled from Move view functions.
- **Purchase** with an on-chain transaction signed by the buyer.
- **Download** only if you're entitled — the backend verifies the on-chain
  entitlement (and proof you control the buyer address) before streaming the
  bytes back. **Shelby credentials never reach the browser.**

> Built against `shelbynet`, Shelby's single, isolated developer network. It is
> **wiped roughly weekly** — everything here is re-seedable with one command
> (`npm run seed`).

---

## Architecture

```
move/                       Aptos Move package — the on-chain marketplace
  sources/marketplace.move    dataset registry + purchase + entitlement + views
packages/storage/           Storage abstraction (decoupled from the SDK)
  src/StorageClient.ts        interface: upload(file)->handle, getReadRef, download
  src/shelby.ts               real impl over @shelby-protocol/sdk (server-side)
  src/mock.ts                 in-memory impl for tests / offline dev
apps/api/                   Thin backend gate (holds the Shelby key; verifies entitlement)
apps/web/                   Vite + React frontend (dev-keypair signer)
scripts/                    deploy_move.ts + seed.ts (one-command re-seed)
```

### How access is gated (and why)

Shelby content, once read, can't be clawed back — enforcement happens at the
point of **granting a read**, not via DRM afterward. So Corpus gates the grant:

1. The buyer calls `purchase(dataset_id)` on the Move contract (signed by their
   own account). This records a non-transferable entitlement on-chain.
2. To download, the browser asks the backend. The backend:
   - issues a single-use challenge; the client signs it with the buyer key,
     **proving control of the buyer address** (the on-chain entitlement is
     public, so this stops anyone passing someone else's address);
   - checks `is_entitled(buyer, dataset_id)` on-chain (**fails closed** on any
     doubt);
   - only then uses the **server-held** Shelby key to fetch and stream the bytes.

The Shelby private key and any `AG-…` API key live **only** in the backend env.
The frontend is Vite — only `VITE_*` vars reach the browser, so secrets can't
leak into the bundle.

### Why the "storage handle" is `(account, blobName)`

`@shelby-protocol/sdk`'s `ShelbyClient.upload()` returns **`void`** — there is no
server-minted id. A blob is addressed for reads by the pair
**(uploader account address, blobName)**. So each Move listing stores
`storage_account: address` + `blob_name: String`, and that pair is exactly what
the backend feeds to `download()`.

---

## Prerequisites

- **Node 20+** and **npm**.
- The **`aptos` CLI** on your PATH (used to publish the Move package):
  see <https://aptos.dev/tools/aptos-cli/>.
- Network access to `shelbynet` (the egress must reach `*.shelby.xyz` and
  `faucet.shelbynet.shelby.xyz`).

---

## Zero → running demo

```bash
# 1. Install
npm install

# 2. Create an operator key (this account uploads to Shelby and serves reads).
#    Generate one with the aptos CLI, or any Ed25519 key:
aptos key generate --key-type ed25519 --output-file operator.key
#    -> prints the private key; copy the value.

# 3. Configure env
cp .env.example .env
#    Edit .env and set:
#      SHELBY_PRIVATE_KEY=<operator private key>   (raw 0x.. or AIP-80 form)
#      CORPUS_NETWORK=shelbynet
#    (Leave SHELBY_API_KEY blank unless your shelbynet RPC requires one.)

# 4. Build the storage package (the api/scripts consume its dist)
npm run build

# 5. Seed: fund + publish contract + upload sample + create listing — one command
npm run seed
#    On success it prints the module address. Copy it into .env:
#      CORPUS_MODULE_ADDRESS=<printed address>
#      VITE_CORPUS_MODULE_ADDRESS=<printed address>

# 6. Run it (two terminals)
npm run api    # backend gate on :8787
npm run web    # frontend on http://localhost:5173
```

Open <http://localhost:5173>, click **Fund (faucet)** to fund the in-browser dev
account, **Buy** a dataset, then **Download** it.

### Re-seeding after a weekly wipe

Just run `npm run seed` again. It re-funds, re-publishes the contract if it's
gone, uploads a fresh sample, and creates a new listing. Update
`CORPUS_MODULE_ADDRESS` only if the operator address changed (it won't, unless
you change the key).

---

## End-to-end behavior (acceptance)

- Upload a dataset → it appears as a listing.
- Purchase from a buyer account → entitlement recorded on-chain.
- Download **denied (403)** for a non-entitled account; **allowed** after
  purchase.
- Expired/missing blobs surface as **410/404**; RPC failures **fail closed**.

Try the denial path: open the app in a second browser profile (a fresh dev
account), and hit **Download** on a dataset you haven't bought — the backend
returns `not entitled`.

---

## Development

```bash
npm run typecheck      # storage + api + web + scripts
npm test               # storage adapter unit tests (mock)
npm run move:test      # Move unit tests (requires the aptos CLI)
```

The storage adapter has a `MockStorageClient` so the app and tests run without
Shelby. Point the backend at it by swapping the `ShelbyStorageClient`
construction in `apps/api/src/server.ts` if you want a fully offline demo.

---

## Configuration reference

All config is in `.env` (see `.env.example`). Server-only secrets:
`SHELBY_PRIVATE_KEY`, `SHELBY_API_KEY`. Browser-exposed (public by design):
`VITE_API_BASE`, `VITE_CORPUS_MODULE_ADDRESS`, `VITE_CORPUS_NETWORK`.

### Verified Shelby/Aptos facts this build relies on

| Thing | Value | Source |
|---|---|---|
| SDK upload | `ShelbyClient.upload({blobData, signer, blobName, expirationMicros}) -> void` | `@shelby-protocol/sdk@0.3.1` types |
| SDK download | `download({account, blobName}) -> ShelbyBlob{readable, contentLength}` | same |
| Shelby RPC (shelbynet) | `https://api.shelbynet.shelby.xyz/shelby` | SDK `NetworkToShelbyRPCBaseUrl` |
| Aptos REST (shelbynet) | `https://api.shelbynet.shelby.xyz/v1` | `@aptos-labs/ts-sdk` `Network.SHELBYNET` |
| Aptos faucet (shelbynet) | `https://faucet.shelbynet.shelby.xyz` | same |
| ts-sdk version | **v6** (`^6.3.1`) — the Shelby SDK peers on `^5 \|\| ^6`, not v7 | SDK `peerDependencies` |

---

## Limitations / TODO (v1 scope)

- **Dev keypair signer**, not a real wallet. shelbynet is a custom isolated
  network that browser wallets (Petra, etc.) don't support out of the box.
  _TODO(mainnet):_ wire `@aptos-labs/wallet-adapter-react` and keep the dev
  signer behind a flag.
- **Payment in APT** only. The Move payment path is isolated in `charge_buyer()`
  so the asset can be swapped. _TODO:_ parameterize the coin / fungible asset.
- **API key for reads** is wired as an optional env var; whether shelbynet
  _requires_ one for reads should be confirmed against live docs at deploy time.
- Challenge store is in-memory (single process). _TODO:_ Redis + rate limiting.
- No tokenomics, subscriptions, ratings, or multi-chain — out of scope for v1.
