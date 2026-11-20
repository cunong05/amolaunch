/**
 * AmoLaunch — a READ-ONLY explorer for the Ammora protocol on
 * GIWA Sepolia (chain 91342), built with @ammora-protocol/sdk@0.3.9.
 *
 * Everything on this page is a live on-chain read or an SDK-computed quote:
 *  - deployment catalog + ConfigRegistry reads (getAmmoraV4ConfigAtBlock)
 *  - LaunchFactory LaunchCreated event discovery
 *  - bonding-curve state + exact-input quotes (AmmoraV4LaunchCurveClient)
 * No wallet is connected, nothing is signed, no transaction is ever sent.
 */
import {
  createPublicClient,
  http,
  fallback,
  defineChain,
  formatUnits,
  parseUnits,
  zeroAddress,
} from "viem";
import {
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAutoRoute,
  getAmmoraV4NextConfigId,
  getAmmoraV4ConfigAtBlock,
  resolveAmmoraFinalizedHead,
  verifyAmmoraV4CoreAtBlock,
  AmmoraV4LaunchCurveClient,
  classifyAmmoraV4ExactInputFill,
  ammoraLaunchFactoryV4Abi,
} from "@ammora-protocol/sdk";

/* ------------------------------------------------------------------ setup */

const deployment = giwaSepoliaAutoRouteDeployment;
const LAUNCH = deployment.contracts.launch;
const CORE = {
  configRegistry: LAUNCH.configRegistry,
  launchFactory: LAUNCH.factory,
  graduationAdapter: LAUNCH.graduationAdapter,
  feePolicy: LAUNCH.feePolicy,
};
const EXPLORER = "https://sepolia-explorer.giwa.io";

// GIWA's public RPCs. The flashblocks endpoint is listed first because it
// answers reliably; the SDK-default RPC is the fallback. Both are official
// public testnet endpoints — reads only.
const RPC_URLS = [
  "https://sepolia-rpc-flashblocks.giwa.io",
  deployment.chain.rpcUrls[0],
];

const chain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: RPC_URLS } },
});

const client = createPublicClient({
  chain,
  transport: fallback(RPC_URLS.map((url) => http(url, { timeout: 20_000, retryCount: 1 }))),
  batch: { multicall: { wait: 32 } },
});

const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];
const LAUNCH_CREATED = ammoraLaunchFactoryV4Abi.find(
  (i) => i.type === "event" && i.name === "LaunchCreated",
);
const QUARANTINED_CONFIG_ID = 6n; // flagged in the official Ammora docs; disabled on-chain

/* ---------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—");
const explorerLink = (addr) => {
  const a = h("a", null, short(addr));
  a.href = `${EXPLORER}/address/${addr}`;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.title = addr;
  return a;
};
const fmt = (raw, decimals, maxFrac = 6) => {
  const s = formatUnits(raw, decimals);
  if (!s.includes(".")) return s;
  const [i, f] = s.split(".");
  const trimmed = f.slice(0, maxFrac).replace(/0+$/, "");
  return trimmed ? `${i}.${trimmed}` : i;
};
const statusLabel = (status) =>
  status === 1 ? "Active" : status === 2 ? "Ready to migrate" : status === 3 ? "Migrated" : `Status ${status}`;

const tokenMetaCache = new Map();
async function tokenMeta(address) {
  const key = address.toLowerCase();
  if (tokenMetaCache.has(key)) return tokenMetaCache.get(key);
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: ERC20_ABI, functionName: "name" }).catch(() => "Unknown token"),
    client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
    client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
  ]);
  const meta = { address, name, symbol, decimals };
  tokenMetaCache.set(key, meta);
  return meta;
}

function row(label, valueNodeOrText) {
  const div = h("div");
  div.append(h("span", null, label));
  const val = h("span");
  if (typeof valueNodeOrText === "string") val.textContent = valueNodeOrText;
  else val.append(valueNodeOrText);
  div.append(val);
  return div;
}

/* ------------------------------------------------------------------ state */

let headBlock = null;
let launches = [];
let selected = null; // { token, curve, configId, name, symbol, decimals }
let direction = "buy"; // 'buy' = quote token -> token, 'sell' = token -> quote token
let quoteMeta = null; // metadata of the curve quote token (WETH)

/* ---------------------------------------------------------------- configs */

async function loadConfigs() {
  const grid = $("configGrid");
  grid.replaceChildren(h("p", "muted", "Loading configs from chain…"));
  const nextId = await getAmmoraV4NextConfigId(client, LAUNCH.configRegistry, headBlock);
  const total = nextId > 1n ? nextId - 1n : 0n;
  const show = total > 12n ? 12n : total;
  grid.replaceChildren();
  for (let n = 0n; n < show; n++) {
    const id = total - n;
    try {
      const entry = await getAmmoraV4ConfigAtBlock(client, LAUNCH.configRegistry, id, headBlock);
      grid.append(configCard(entry, total));
    } catch (e) {
      console.warn(`config ${id} failed`, e);
    }
  }
  if (!grid.children.length) grid.append(h("p", "err", "Could not load configs from the RPC. Try Refresh."));
}

function configCard(entry, total) {
  const card = h("article", "card");
  const title = h("h3", null, `Config #${entry.configId.toString()}`);
  const quarantined = entry.configId === QUARANTINED_CONFIG_ID;
  if (entry.configId === total) title.append(h("span", "badge on", "newest"));
  title.append(
    quarantined
      ? h("span", "badge warn", "quarantined in docs")
      : h("span", `badge ${entry.enabled ? "on" : "off"}`, entry.enabled ? "enabled" : "disabled"),
  );
  card.append(title);

  const rows = h("div", "rows");
  rows.append(row("Owner", explorerLink(entry.identity.owner)));
  const quoteSpan = h("span", null, "…");
  tokenMeta(entry.config.quoteToken).then((m) => {
    quoteSpan.textContent = `${m.symbol} · ${short(entry.config.quoteToken)}`;
    quoteSpan.title = entry.config.quoteToken;
  });
  rows.append(row("Quote token", quoteSpan));
  rows.append(row("Migration mode", String(entry.config.migrationMode)));
  rows.append(row("Curve segments", String(entry.segments.length)));
  const hash = h("span", null, short(entry.configHash));
  hash.title = entry.configHash;
  rows.append(row("Config hash", hash));
  card.append(rows);
  return card;
}

/* ---------------------------------------------------------------- launches */

async function loadLaunches() {
  const grid = $("launchGrid");
  const status = h("p", "muted", "Scanning the factory for launches…");
  grid.replaceChildren(status);
  launches = [];

  const CHUNK = 5000n;
  const MAX_BACK = 200_000n;
  const WANT = 10;
  const found = [];
  let to = headBlock;
  while (found.length < WANT && headBlock - to < MAX_BACK) {
    const from = to - CHUNK + 1n;
    status.textContent = `Scanning LaunchCreated events… block ${from.toString()} – ${to.toString()} (${found.length} found)`;
    try {
      const logs = await client.getLogs({
        address: LAUNCH.factory,
        event: LAUNCH_CREATED,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of [...logs].reverse()) {
        found.push({
          token: log.args.token,
          curve: log.args.curve,
          creator: log.args.creator,
          configId: log.args.configId,
          block: log.blockNumber,
        });
        if (found.length >= WANT) break;
      }
    } catch (e) {
      console.warn(`getLogs ${from}-${to} failed`, e);
    }
    to = from - 1n;
  }

  grid.replaceChildren();
  if (!found.length) {
    grid.append(h("p", "err", "No launches found in the scanned range. Try Refresh."));
    return;
  }
  for (const launch of found) {
    const card = await launchCard(launch);
    launches.push(launch);
    grid.append(card);
  }
  const firstActive = launches.find((l) => l.curveStatus === 1);
  if (firstActive && !selected) selectLaunch(firstActive, false);
}

async function launchCard(launch) {
  const card = h("article", "card");
  const meta = await tokenMeta(launch.token).catch(() => ({
    name: "Unknown token",
    symbol: "???",
    decimals: 18,
  }));
  Object.assign(launch, { name: meta.name, symbol: meta.symbol, decimals: meta.decimals });

  const title = h("h3", null, meta.name);
  title.append(h("span", "sym", meta.symbol));
  card.append(title);

  let curveStatus = null;
  try {
    const curveClient = new AmmoraV4LaunchCurveClient(client, launch.curve, CORE);
    const state = await curveClient.getStateAtBlock(headBlock);
    curveStatus = state.status;
    launch.feeBps = state.currentFeeBps;
    if (!quoteMeta && state.quoteToken) quoteMeta = await tokenMeta(state.quoteToken);
  } catch (e) {
    console.warn("curve state failed", launch.curve, e);
  }
  launch.curveStatus = curveStatus;

  const rows = h("div", "rows");
  rows.append(
    row(
      "Curve status",
      curveStatus === null
        ? "unavailable"
        : `${statusLabel(curveStatus)} (status ${curveStatus})`,
    ),
  );
  rows.append(row("Config", `#${launch.configId.toString()}`));
  rows.append(row("Token", explorerLink(launch.token)));
  rows.append(row("Curve", explorerLink(launch.curve)));
  rows.append(row("Creator", explorerLink(launch.creator)));
  rows.append(row("Launched at block", launch.block.toString()));
  if (launch.feeBps !== undefined) rows.append(row("Curve fee", `${(launch.feeBps / 100).toFixed(2)}%`));
  card.append(rows);

  const actions = h("div", "actions");
  const btn = h("button", "ghost small", curveStatus === 1 ? "Quote this launch" : "View in quote panel");
  btn.type = "button";
  btn.addEventListener("click", () => {
    selectLaunch(launch, true);
  });
  actions.append(btn);
  card.append(actions);
  return card;
}

/* ------------------------------------------------------------- quote panel */

function selectLaunch(launch, scroll) {
  selected = launch;
  const box = $("qSelected");
  box.replaceChildren(
    h("span", null, "Selected: "),
    h("strong", null, `${launch.name} (${launch.symbol})`),
    h("span", "muted", ` · curve ${short(launch.curve)} · config #${launch.configId.toString()}`),
  );
  updateAmountLabel();
  if (scroll) $("quotePanel").scrollIntoView({ behavior: "smooth", block: "center" });
}

function updateAmountLabel() {
  const inSymbol =
    direction === "buy" ? quoteMeta?.symbol ?? "WETH" : selected?.symbol ?? "token";
  $("amountLabel").textContent = `Amount in (${inSymbol})`;
  $("dirBuy").classList.toggle("active", direction === "buy");
  $("dirSell").classList.toggle("active", direction === "sell");
}

function quoteMessage(node) {
  $("quoteResult").replaceChildren(node);
}
function quoteError(msg) {
  quoteMessage(h("span", "err", msg));
}

async function runQuote() {
  if (!selected) return quoteError("Select a launch first — use a “Quote this launch” button above.");
  const inMeta =
    direction === "buy" ? quoteMeta ?? { symbol: "WETH", decimals: 18 } : selected;
  const outMeta = direction === "buy" ? selected : quoteMeta ?? { symbol: "WETH", decimals: 18 };
  let amountIn;
  try {
    amountIn = parseUnits($("amountInput").value.trim(), inMeta.decimals);
  } catch {
    return quoteError("That amount is not a valid number for this token's decimals.");
  }
  if (amountIn <= 0n) return quoteError("Enter an amount above zero.");

  const btn = $("quoteBtn");
  btn.disabled = true;
  quoteMessage(h("span", "muted", "Reading the curve at the finalized head…"));
  try {
    const head = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
    const curveClient = new AmmoraV4LaunchCurveClient(client, selected.curve, CORE);
    const state = await curveClient.getStateAtBlock(head);
    if (state.status !== 1) {
      const wrap = h("div");
      wrap.append(
        h("div", null, `This curve is not active (status ${state.status} — ${statusLabel(state.status)}), so it cannot be quoted.`),
      );
      if (state.canonicalPool && state.canonicalPool !== zeroAddress) {
        const p = h("div");
        p.append(h("span", "muted", "It graduated to pool "), explorerLink(state.canonicalPool));
        wrap.append(p);
      }
      quoteMessage(wrap);
      return;
    }
    const baseForQuote = direction === "sell";
    const q = await curveClient.quoteExactInputAtBlock(amountIn, baseForQuote, head);
    const fill = classifyAmmoraV4ExactInputFill(q, baseForQuote);

    const wrap = h("div");
    const big = h("div", "big", `≈ ${fmt(q.amountOut, outMeta.decimals)} ${outMeta.symbol}`);
    wrap.append(big);
    const rows = h("div", "rows");
    rows.append(row("You pay (simulated)", `${fmt(amountIn, inMeta.decimals)} ${inMeta.symbol}`));
    rows.append(row("Curve fee", `${fmt(q.fee, inMeta.decimals)} ${inMeta.symbol}`));
    if (q.amountLeft > 0n) {
      rows.append(row("Unfilled / returned", `${fmt(q.amountLeft, inMeta.decimals)} ${inMeta.symbol}`));
    }
    rows.append(row("Fill type", fill.kind));
    rows.append(row("Quoted at block", q.asOfBlock.toString()));
    wrap.append(rows);
    if (fill.kind === "graduation-boundary") {
      wrap.append(
        h("p", "muted", "This buy reaches the graduation boundary: the curve can only consume part of the input; the remainder would be returned to the payer."),
      );
    }
    wrap.append(h("p", "muted", "Read-only SDK quote — no wallet, no signature, no transaction."));
    quoteMessage(wrap);
  } catch (e) {
    console.error(e);
    quoteError(`Quote failed: ${e.shortMessage || e.message || e}`);
  } finally {
    btn.disabled = false;
  }
}

/* -------------------------------------------------------------------- init */

function renderContractBar() {
  const bar = $("contractBar");
  bar.replaceChildren();
  const items = [
    ["ConfigRegistry", LAUNCH.configRegistry],
    ["LaunchFactory", LAUNCH.factory],
    ["GraduationAdapter", LAUNCH.graduationAdapter],
    ["FeePolicy", LAUNCH.feePolicy],
  ];
  for (const [label, addr] of items) {
    const span = h("span");
    span.append(h("b", null, `${label}: `), explorerLink(addr));
    bar.append(span);
  }
  const slot = h("span");
  slot.append(h("b", null, "Deployment slot: "), h("span", null, deployment.slot));
  bar.append(slot);
}

let loading = false;
async function init() {
  if (loading) return;
  loading = true;
  $("refreshBtn").disabled = true;
  try {
    renderContractBar();
    headBlock = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
    $("blockPill").textContent = `finalized block ${headBlock.toString()}`;
    try {
      await verifyAmmoraV4CoreAtBlock(client, CORE, headBlock);
      $("corePill").hidden = false;
    } catch (e) {
      console.warn("core verification failed", e);
    }
    await loadConfigs();
    await loadLaunches();
    updateAmountLabel();
  } catch (e) {
    console.error(e);
    $("blockPill").textContent = "RPC unavailable — try Refresh";
  } finally {
    loading = false;
    $("refreshBtn").disabled = false;
  }
}

$("dirBuy").addEventListener("click", () => {
  direction = "buy";
  updateAmountLabel();
});
$("dirSell").addEventListener("click", () => {
  direction = "sell";
  updateAmountLabel();
});
$("quoteBtn").addEventListener("click", runQuote);
$("refreshBtn").addEventListener("click", init);

init();
