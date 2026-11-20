# Ammora Launchpad — GIWA Sepolia

A **read-only launchpad explorer** for the [Ammora](https://ammora.org) protocol on
**GIWA Sepolia (chain ID 91342)**, built with the official
[`@ammora-protocol/sdk`](https://www.npmjs.com/package/@ammora-protocol/sdk) `0.3.9`.

**Live site:** https://cunong05.github.io/ammora-launchpad/

Built for the **Ammora Season 2 Builder mission** — “Ship an exchange or launchpad
with the Ammora SDK.”

## What it does

Everything on the page is a live on-chain read or an SDK-computed quote. No wallet
is connected, nothing is signed, and no transaction is ever sent.

- **Deployment catalog** — shows the SDK's reviewed GIWA Sepolia *auto-route* V4
  deployment (`giwaSepoliaAutoRouteDeployment`): ConfigRegistry, LaunchFactory,
  GraduationAdapter and FeePolicy, plus the finalized chain head
  (`resolveAmmoraFinalizedHead`) and a runtime check of the V4 core contracts
  (`verifyAmmoraV4CoreAtBlock`).
- **Launch Configs** — the newest reusable launch policies registered in the
  ConfigRegistry, read at the finalized block with `getAmmoraV4NextConfigId` and
  `getAmmoraV4ConfigAtBlock` (owner, quote token, migration mode, segments, hash).
- **Latest Launches** — tokens issued through the LaunchFactory, discovered by
  scanning `LaunchCreated` events, enriched with ERC-20 metadata and live
  bonding-curve state from `AmmoraV4LaunchCurveClient.getStateAtBlock`
  (status, curve fee, graduation pool when migrated).
- **Curve Quote panel** — pick any launch, choose Buy (WETH → token) or Sell
  (token → WETH), enter an amount, and get an exact-input quote computed by the
  SDK from the curve contract (`quoteExactInputAtBlock`), classified with
  `classifyAmmoraV4ExactInputFill` — including graduation-boundary partial fills
  where the unfilled remainder would be returned.

## Notes & safety choices

- **Read-only by design.** The app holds no keys and constructs no transactions;
  quotes are simulations priced at the finalized head.
- **Quarantined Config #6.** The official Ammora docs flag Config #6
  (hash `0x604890…667`, Registry `0x6d043014972b87406C4757a5f2d655A24e0b0aF9`) as
  quarantined for new launches; it is disabled on-chain. This site never features
  it or uses it as a default — it only appears in the registry listing with its
  real status, like every other Config.
- **RPC endpoints.** Reads go to GIWA's official public testnet RPCs
  (`sepolia-rpc-flashblocks.giwa.io` first, the SDK-default `sepolia-rpc.giwa.io`
  as fallback) via a viem `fallback` transport with Multicall batching.
- GIWA Sepolia is a testnet; all tokens and amounts shown have no real value.

## Run it locally

Requires Node 24 (the version the Ammora docs validate against).

```bash
npm install
npm run dev      # local dev server
npm run build    # production build into dist/
npm run preview  # preview the production build
```

## Tech

- `@ammora-protocol/sdk@0.3.9` — deployment catalog, Config/curve reads, quotes
- `viem` — public client, transports, log scanning
- `vite` — bundling; deployed to GitHub Pages by the workflow in
  `.github/workflows/pages.yml`
