/* Geomacro live V1/V2 onchain analytics
 * Read-only. No wallet, no private key, no contract writes.
 * V1 = legacy AgentArena
 * V2 = AgentArenaV2 behind the permanent proxy
 */
(function () {
  "use strict";

  const CONFIG = {
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    explorer: "https://testnet.arcscan.app",
    v1: {
      version: "v1",
      name: "V1 Legacy AgentArena",
      address: "0xC026fDFC40Dcd8F07b6ecFA21b2BF8400Db0FADe",
      fromBlock: 0,
    },
    v2: {
      version: "v2",
      name: "V2 AgentArenaV2 Proxy",
      address: "0x2F874FB07084a22D2bB314D0762Af57Cb1856868",
      implementation: "0x96DDb29e27bdc3edf0c27bf885840Ebf8151DA7c",
      fromBlock: 56797869,
    },
    logChunk: 20000,
    concurrency: 3,
    maxMarkets: 2000,
    refreshMs: 5 * 60 * 1000,
    retryAttempts: 5,
    retryBaseDelayMs: 800,
    chunkStaggerMs: 250,
  };

  const V1_ABI = [
    "function getMarket(string marketId) view returns (uint8 status, uint256 hawkTotal, uint256 doveTotal, bool exists)",
    "function getMarketFullDetails(string marketId) view returns (uint8 status, uint8 winner, uint8 tentativeWinner, uint256 stakingEndTime, uint256 resolutionTime, uint256 aiResolutionTime, address disputer)",
    "event MarketCreated(string marketId, uint256 stakingEndTime, uint256 resolutionTime)",
    "event Staked(string marketId, address indexed user, uint8 side, uint256 amount)"
  ];

  const V2_ABI = [
    "function getMarket(string marketId) view returns (uint8 status, uint256 hawkTotal, uint256 doveTotal, bool exists)",
    "function getMarketFullDetails(string marketId) view returns (uint8 status, uint8 winner, uint8 tentativeWinner, uint256 stakingEndTime, uint256 resolutionTime, uint256 aiResolutionTime, address disputer, uint256 disputeBond, uint256 disputeRaisedAt)",
    "event MarketCreated(string marketId, uint256 stakingEndTime, uint256 resolutionTime)",
    "event Staked(string marketId, address indexed user, uint8 side, uint256 amount)"
  ];

  const $ = (id) => document.getElementById(id);
  const unavailable = (label = "Unavailable") => label;

  function shortAddress(a) {
    if (!a) return unavailable();
    return `${a.slice(0, 6)}...${a.slice(-4)}`;
  }

  function fmt(n, digits = 0) {
    if (!Number.isFinite(n)) return unavailable();
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function usdc(value) {
    try {
      return Number(ethers.formatUnits(value, 18));
    } catch {
      return null;
    }
  }

  function statusName(status) {
    const names = ["OPEN", "LOCKED", "AI RESOLVED", "DISPUTED", "FINALIZED"];
    return names[Number(status)] || `STATUS ${Number(status)}`;
  }

  function winnerName(v) {
    const code = Number(v);
    if (code === 1) return "HAWK";
    if (code === 2) return "DOVE";
    return code === 0 ? "PENDING" : "UNAVAILABLE";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isRateLimitError(err) {
    const status = err?.error?.code ?? err?.status ?? err?.code;
    if (status === 429) return true;
    const msg = String(err?.error?.message || err?.shortMessage || err?.message || "");
    return /429|rate limit|too many requests/i.test(msg);
  }

  // Retries an RPC call with exponential backoff + jitter, but only for
  // rate-limit (429) style errors. Other errors (bad request, contract
  // revert, etc.) fail fast since retrying them would just waste time.
  async function withRetry(fn, { retries = CONFIG.retryAttempts, baseDelay = CONFIG.retryBaseDelayMs } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isRateLimitError(err) || attempt === retries) throw err;
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 250;
        console.warn(`[onchain] RPC rate limited (429); retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries})`);
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  async function getLatestBlock(provider) {
    return withRetry(() => provider.getBlockNumber());
  }

  async function queryInChunks(contract, filter, fromBlock, toBlock) {
    const out = [];
    if (fromBlock > toBlock) return out;

    for (let start = fromBlock; start <= toBlock; start += CONFIG.logChunk) {
      const end = Math.min(toBlock, start + CONFIG.logChunk - 1);
      try {
        out.push(...await withRetry(() => contract.queryFilter(filter, start, end)));
        if (start + CONFIG.logChunk <= toBlock) await sleep(CONFIG.chunkStaggerMs);
        continue;
      } catch (firstErr) {
        console.warn("[onchain] large log range rejected; retrying smaller windows", start, end, firstErr);
      }

      const half = Math.max(1000, Math.floor(CONFIG.logChunk / 4));
      for (let s = start; s <= end; s += half) {
        const e = Math.min(end, s + half - 1);
        try {
          out.push(...await withRetry(() => contract.queryFilter(filter, s, e)));
        } catch (err) {
          console.warn("[onchain] log range failed", s, e, err);
        }
        if (e < end) await sleep(CONFIG.chunkStaggerMs);
      }
    }
    return out;
  }

  async function mapLimit(items, limit, fn) {
    const result = new Array(items.length);
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          result[i] = await fn(items[i], i);
        } catch (err) {
          result[i] = { ...items[i], error: err?.message || String(err) };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return result;
  }

  async function loadSupabaseMarkets(sb) {
    const { data, error } = await sb
      .from("events")
      .select("id,market_address,market_created,market_resolved,created_at,title,market_question")
      .eq("market_created", true)
      .order("created_at", { ascending: true })
      .limit(CONFIG.maxMarkets);

    if (error) throw error;

    return (data || []).map((row) => {
      const address = String(row.market_address || CONFIG.v1.address).toLowerCase();
      const version = address === CONFIG.v2.address.toLowerCase() ? "v2" : "v1";
      return {
        marketId: `mkt_${row.id}`,
        eventId: row.id,
        version,
        marketAddress: version === "v2" ? CONFIG.v2.address : CONFIG.v1.address,
        title: row.market_question || row.title || `Market ${row.id}`,
        createdAt: row.created_at || null,
        dbResolved: row.market_resolved === true,
      };
    });
  }

  async function loadCreatedEvents(provider, versionConfig, abi) {
    const contract = new ethers.Contract(versionConfig.address, abi, provider);
    const latest = await getLatestBlock(provider);
    const events = await queryInChunks(contract, contract.filters.MarketCreated(), versionConfig.fromBlock, latest);
    const byId = new Map();

    for (const ev of events) {
      const marketId = ev.args?.[0];
      if (!marketId) continue;
      const id = String(marketId);
      byId.set(id, {
        marketId: id,
        version: versionConfig.version,
        marketAddress: versionConfig.address,
        title: `Onchain market ${id}`,
        createdAt: null,
        eventBlock: ev.blockNumber,
      });
    }

    return [...byId.values()];
  }

  async function readMarket(provider, item) {
    const abi = item.version === "v2" ? V2_ABI : V1_ABI;
    const contract = new ethers.Contract(item.marketAddress, abi, provider);

    try {
      const basic = await withRetry(() => contract.getMarket(item.marketId));
      let full = null;
      try {
        full = await withRetry(() => contract.getMarketFullDetails(item.marketId));
      } catch (err) {
        console.warn("[onchain] full detail read unavailable", item.marketId, err);
      }

      const hawk = usdc(basic[1]);
      const dove = usdc(basic[2]);
      const total = Number.isFinite(hawk) && Number.isFinite(dove) ? hawk + dove : null;

      return {
        ...item,
        exists: Boolean(basic[3]),
        status: Number(basic[0]),
        statusLabel: statusName(basic[0]),
        hawkTotalRaw: basic[1].toString(),
        doveTotalRaw: basic[2].toString(),
        hawkTotal: hawk,
        doveTotal: dove,
        totalStaked: total,
        winner: full ? Number(full[1]) : null,
        tentativeWinner: full ? Number(full[2]) : null,
        stakingEndTime: full ? Number(full[3]) : null,
        resolutionTime: full ? Number(full[4]) : null,
        aiResolutionTime: full ? Number(full[5]) : null,
        disputer: full ? full[6] : null,
        disputeBond: full && full.length > 7 ? usdc(full[7]) : null,
        disputeRaisedAt: full && full.length > 8 ? Number(full[8]) : null,
      };
    } catch (error) {
      return {
        ...item,
        exists: null,
        status: null,
        statusLabel: unavailable(),
        hawkTotal: null,
        doveTotal: null,
        totalStaked: null,
        error: error?.message || String(error),
      };
    }
  }

  async function loadPositions(sb, markets) {
    const { data, error } = await sb
      .from("positions")
      .select("wallet_address,market_id,side,staked_amount_raw")
      .limit(10000);

    if (error) return { positions: { v1: 0, v2: 0 }, wallets: { v1: new Set(), v2: new Set() }, staked: { v1: 0, v2: 0 }, error };

    const byEventId = new Map();
    for (const m of markets) {
      if (m.eventId) byEventId.set(String(m.eventId), m.version);
    }

    const wallets = { v1: new Set(), v2: new Set() };
    const positions = { v1: 0, v2: 0 };
    const staked = { v1: 0, v2: 0 };

    for (const row of data || []) {
      const version = byEventId.get(String(row.market_id));
      if (!version) continue;
      positions[version] += 1;
      if (row.wallet_address) wallets[version].add(String(row.wallet_address).toLowerCase());
      try {
        staked[version] += Number(ethers.formatUnits(row.staked_amount_raw || "0", 18));
      } catch {
        // Keep the aggregate unchanged when a single row is malformed.
      }
    }

    return { positions, wallets, staked, error: null };
  }

  function css() {
    if (document.getElementById("onchain-live-style")) return;
    const style = document.createElement("style");
    style.id = "onchain-live-style";
    style.textContent = `
      .onchain-section { margin-top: 56px; opacity:1 !important; transform:none !important; }
      .onchain-coverage { display:grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap:14px; margin-top:18px; }
      .version-panel { margin-top:18px; }
      .version-panel .panel-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
      .version-title { display:flex; align-items:center; gap:10px; font-size:15px; font-weight:700; }
      .version-badge { display:inline-flex; align-items:center; justify-content:center; min-width:42px; padding:5px 8px; border-radius:7px; font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.08em; }
      .version-v1 { background:rgba(245,158,11,.11); border:1px solid rgba(245,158,11,.28); color:var(--hawk); }
      .version-v2 { background:rgba(56,189,248,.11); border:1px solid rgba(56,189,248,.28); color:var(--dove); }
      .version-combined { background:rgba(167,139,250,.11); border:1px solid rgba(167,139,250,.28); color:var(--purple); }
      .version-meta { font-family:var(--mono); font-size:10px; color:var(--muted-2); margin-top:5px; }
      .version-link { color:var(--dove); text-decoration:none; border-bottom:1px solid rgba(56,189,248,.25); }
      .version-link:hover { border-bottom-color:var(--dove); }
      .metrics-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:14px; }
      .metric-card { border:1px solid var(--border); background:rgba(255,255,255,.025); border-radius:14px; padding:16px; min-width:0; }
      .metric-label { font-family:var(--mono); text-transform:uppercase; letter-spacing:.08em; color:var(--muted-2); font-size:9.5px; }
      .metric-value { margin-top:8px; font-family:var(--mono); font-size:20px; font-weight:650; font-variant-numeric:tabular-nums; }
      .metric-hint { margin-top:4px; color:var(--muted); font-size:10.5px; line-height:1.4; }
      .data-table-wrap { margin-top:14px; border:1px solid var(--border); border-radius:14px; overflow:auto; background:rgba(0,0,0,.12); }
      .data-table { width:100%; min-width:720px; border-collapse:collapse; font-family:var(--mono); font-size:11px; }
      .data-table th { position:sticky; top:0; background:#0b0b10; color:var(--muted-2); text-transform:uppercase; letter-spacing:.06em; font-size:9px; font-weight:600; text-align:left; padding:11px 12px; border-bottom:1px solid var(--border); }
      .data-table td { padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.055); color:var(--text); white-space:nowrap; }
      .data-table tr:last-child td { border-bottom:0; }
      .data-table .num { text-align:right; font-variant-numeric:tabular-nums; }
      .data-table .muted { color:var(--muted); }
      .state-badge { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:6px; padding:3px 6px; font-size:9px; letter-spacing:.05em; }
      .status-live { color:var(--success); border-color:rgba(52,211,153,.25); background:rgba(52,211,153,.06); }
      .status-warn { color:var(--hawk); border-color:rgba(245,158,11,.25); background:rgba(245,158,11,.06); }
      .coverage-note { margin-top:10px; color:var(--muted-2); font-size:10.5px; line-height:1.55; }
      .onchain-warning { margin-top:12px; border:1px dashed rgba(245,158,11,.25); color:var(--muted); background:rgba(245,158,11,.035); border-radius:12px; padding:12px 14px; font-size:11.5px; line-height:1.55; }
      @media (max-width: 900px) { .metrics-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .onchain-coverage { grid-template-columns:1fr; } }
      @media (max-width: 560px) { .metrics-grid { grid-template-columns:1fr 1fr; } .data-table { min-width:680px; } .metric-value { font-size:17px; } }
    `;
    document.head.appendChild(style);
  }

  function metricCard(label, value, hint = "") {
    return `<div class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-hint">${escapeHtml(hint)}</div></div>`;
  }

  function renderVersionTable(items) {
    const rows = items
      .filter((m) => m && m.exists !== false)
      .sort((a, b) => String(a.marketId).localeCompare(String(b.marketId)))
      .slice(0, 100);

    if (!rows.length) {
      return `<div class="onchain-warning">No verified live market records are available for this version.</div>`;
    }

    return `
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr>
            <th>Market</th><th>State</th><th class="num">Hawk</th><th class="num">Dove</th><th class="num">Total</th><th class="num">Winner</th>
          </tr></thead>
          <tbody>
            ${rows.map((m) => {
              const stateClass = m.error ? "status-warn" : "status-live";
              return `<tr>
                <td title="${escapeHtml(m.marketId)}">${escapeHtml(m.marketId.length > 28 ? `${m.marketId.slice(0, 24)}...` : m.marketId)}</td>
                <td><span class="state-badge ${stateClass}">${escapeHtml(m.statusLabel || unavailable())}</span></td>
                <td class="num">${escapeHtml(m.hawkTotal == null ? unavailable() : fmt(m.hawkTotal, 2))}</td>
                <td class="num">${escapeHtml(m.doveTotal == null ? unavailable() : fmt(m.doveTotal, 2))}</td>
                <td class="num">${escapeHtml(m.totalStaked == null ? unavailable() : fmt(m.totalStaked, 2))}</td>
                <td class="num">${escapeHtml(m.winner == null ? unavailable() : winnerName(m.winner))}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      ${rows.length >= 100 ? `<div class="coverage-note">Showing the first 100 readable markets. Summary metrics include the full discovered set.</div>` : ""}
    `;
  }

  function renderVersionPanel(version, items, positionData) {
    const config = version === "v1" ? CONFIG.v1 : CONFIG.v2;
    const readable = items.filter((m) => m.exists === true);
    const active = readable.filter((m) => m.status !== 4);
    const resolved = readable.filter((m) => m.status === 4 || Boolean(m.dbResolved)).length;
    const stakeValues = readable.map((m) => m.totalStaked).filter(Number.isFinite);
    const onchainStake = stakeValues.length ? stakeValues.reduce((a, b) => a + b, 0) : null;
    const label = version.toUpperCase();
    const badgeClass = version === "v1" ? "version-v1" : "version-v2";
    const addressLink = `${CONFIG.explorer}/address/${config.address}`;

    return `
      <div class="card version-panel">
        <div class="panel-head">
          <div>
            <div class="version-title"><span class="version-badge ${badgeClass}">${label}</span> ${escapeHtml(config.name)}</div>
            <div class="version-meta">${escapeHtml(shortAddress(config.address))} · <a class="version-link" href="${addressLink}" target="_blank" rel="noreferrer">View contract</a></div>
          </div>
          <div class="version-meta">Arc Testnet · Chain ${CONFIG.chainId}</div>
        </div>
        <div class="metrics-grid">
          ${metricCard("Markets discovered", fmt(items.length), "Known from live index / onchain discovery")}
          ${metricCard("Readable onchain", fmt(readable.length), "Verified by getMarket()")}
          ${metricCard("Active markets", fmt(active.length), "Currently not finalized")}
          ${metricCard("Resolved markets", fmt(resolved), "Finalized or resolved")}
          ${metricCard("Onchain stake", onchainStake == null ? unavailable() : `${fmt(onchainStake, 2)} USDC`, "getMarket() Hawk + Dove totals")}
          ${metricCard("Indexed positions", fmt(positionData.count), "Supabase position mirror")}
          ${metricCard("Unique wallets", fmt(positionData.wallets.size), "Wallets linked to this version")}
          ${metricCard("Position stake", `${fmt(positionData.staked, 2)} USDC`, "Recorded position amounts")}
        </div>
        ${renderVersionTable(items)}
      </div>
    `;
  }

  function ensureSection() {
    let el = $("onchain-live-section");
    if (el) return el;
    const content = $("content");
    if (!content) return null;
    css();
    el = document.createElement("section");
    el.id = "onchain-live-section";
    el.className = "onchain-section";
    content.appendChild(el);
    return el;
  }

  function render(summary) {
    const section = ensureSection();
    if (!section) return;

    const combinedWallets = new Set([...summary.positions.v1.wallets, ...summary.positions.v2.wallets]);
    const totalStake = [summary.v1.onchainStake, summary.v2.onchainStake].filter(Number.isFinite);
    const combinedStake = totalStake.length === 2 ? totalStake[0] + totalStake[1] : null;

    section.innerHTML = `
      <div class="section-head">
        <h2><span class="h2-icon" style="background:rgba(167,139,250,0.12);color:var(--purple);">◈</span> Onchain Market Intelligence</h2>
      </div>
      <p class="subtitle">Independent live views of the legacy V1 contract and the current V2 proxy, followed by a combined protocol snapshot.</p>

      <div class="onchain-coverage">
        <div class="card tone-hawk">
          <div class="card-label">V1 coverage</div>
          <div class="card-value">${fmt(summary.v1.items)}</div>
          <div class="card-hint">${fmt(summary.v1.readable)} verified live records</div>
        </div>
        <div class="card tone-dove">
          <div class="card-label">V2 coverage</div>
          <div class="card-value">${fmt(summary.v2.items)}</div>
          <div class="card-hint">${fmt(summary.v2.readable)} verified live records</div>
        </div>
        <div class="card tone-purple">
          <div class="card-label">Protocol snapshot</div>
          <div class="card-value">${fmt(summary.combined.items)}</div>
          <div class="card-hint">Unique V1 + V2 markets in this snapshot</div>
        </div>
      </div>

      ${renderVersionPanel("v1", summary.v1.markets, summary.positions.v1)}
      ${renderVersionPanel("v2", summary.v2.markets, summary.positions.v2)}

      <div class="card version-panel">
        <div class="panel-head">
          <div>
            <div class="version-title"><span class="version-badge version-combined">ALL</span> Combined protocol view</div>
            <div class="version-meta">V1 legacy + V2 proxy · read-only snapshot</div>
          </div>
          <div class="version-meta">Block ${escapeHtml(String(summary.latestBlock ?? unavailable()))} · ${escapeHtml(summary.updatedAt)}</div>
        </div>
        <div class="metrics-grid">
          ${metricCard("Combined markets", fmt(summary.combined.items), "V1 + V2")}
          ${metricCard("Combined active", fmt(summary.combined.active), "Not finalized")}
          ${metricCard("Combined resolved", fmt(summary.combined.resolved), "Finalized or resolved")}
          ${metricCard("Combined stake", combinedStake == null ? unavailable() : `${fmt(combinedStake, 2)} USDC`, "Onchain totals from both versions")}
          ${metricCard("Combined positions", fmt(summary.positions.v1.count + summary.positions.v2.count), "Supabase position mirror")}
          ${metricCard("Combined wallets", fmt(combinedWallets.size), "Unique across V1 + V2")}
          ${metricCard("RPC status", summary.rpcOk ? "LIVE" : "ERROR", "Arc Testnet")}
          ${metricCard("Last refresh", summary.updatedAt, "Automatic refresh every 5 minutes")}
        </div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr>
              <th>Version</th><th>Market</th><th>State</th><th class="num">Hawk</th><th class="num">Dove</th><th class="num">Total</th><th class="num">Winner</th>
            </tr></thead>
            <tbody>
              ${summary.combined.markets.slice(0, 150).map((m) => `
                <tr>
                  <td><span class="version-badge ${m.version === "v1" ? "version-v1" : "version-v2"}">${m.version.toUpperCase()}</span></td>
                  <td title="${escapeHtml(m.marketId)}">${escapeHtml(m.marketId.length > 24 ? `${m.marketId.slice(0, 20)}...` : m.marketId)}</td>
                  <td><span class="state-badge ${m.error ? "status-warn" : "status-live"}">${escapeHtml(m.statusLabel || unavailable())}</span></td>
                  <td class="num">${escapeHtml(m.hawkTotal == null ? unavailable() : fmt(m.hawkTotal, 2))}</td>
                  <td class="num">${escapeHtml(m.doveTotal == null ? unavailable() : fmt(m.doveTotal, 2))}</td>
                  <td class="num">${escapeHtml(m.totalStaked == null ? unavailable() : fmt(m.totalStaked, 2))}</td>
                  <td class="num">${escapeHtml(m.winner == null ? unavailable() : winnerName(m.winner))}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="coverage-note">V2 historical discovery begins at deployment block ${CONFIG.v2.fromBlock}. V1 legacy coverage comes from the production event index and live contract reads.</div>
      </div>

      ${summary.errors.length ? `<div class="onchain-warning">${escapeHtml(summary.errors.join(" "))}</div>` : ""}
    `;
  }

  async function load() {
    const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
    const errors = [];
    let latestBlock = null;

    try {
      latestBlock = await getLatestBlock(provider);
    } catch (error) {
      errors.push("Arc Testnet RPC is unavailable. Live onchain values cannot be verified right now.");
      render({
        rpcOk: false,
        latestBlock: null,
        updatedAt: new Date().toLocaleTimeString(),
        v1: { items: 0, readable: 0, onchainStake: null, markets: [] },
        v2: { items: 0, readable: 0, onchainStake: null, markets: [] },
        combined: { items: 0, active: 0, resolved: 0, markets: [] },
        positions: {
          v1: { count: 0, wallets: new Set(), staked: 0 },
          v2: { count: 0, wallets: new Set(), staked: 0 },
        },
        errors,
      });
      return;
    }

    let dbMarkets = [];
    try {
      dbMarkets = await loadSupabaseMarkets(window.sb);
    } catch (error) {
      errors.push("The Supabase market index could not be read. V1 historical coverage may be incomplete.");
    }

    let v2Created = [];
    try {
      v2Created = await loadCreatedEvents(provider, CONFIG.v2, V2_ABI);
    } catch (error) {
      errors.push("V2 MarketCreated history is unavailable from Arc RPC. Existing V2 rows remain readable from the production event index.");
    }

    // V1 market discovery intentionally uses the production event index.
    // Scanning the entire V1 contract history from block 0 on every refresh
    // would be unnecessarily expensive for a public RPC. Each discovered V1
    // market is still verified against the live legacy contract below.
    const marketMap = new Map();
    for (const m of dbMarkets) {
      const key = `${m.version}:${m.marketAddress.toLowerCase()}:${m.marketId}`;
      marketMap.set(key, m);
    }
    for (const m of v2Created) {
      const key = `v2:${CONFIG.v2.address.toLowerCase()}:${m.marketId}`;
      if (!marketMap.has(key)) marketMap.set(key, m);
    }

    const markets = [...marketMap.values()].slice(0, CONFIG.maxMarkets);
    const readings = await mapLimit(markets, CONFIG.concurrency, (m) => readMarket(provider, m));

    const byVersion = {
      v1: readings.filter((m) => m.version === "v1"),
      v2: readings.filter((m) => m.version === "v2"),
    };

    const verified = (items) => items.filter((m) => m.exists === true);
    const stakeSum = (items) => {
      const values = verified(items).map((m) => m.totalStaked).filter(Number.isFinite);
      return values.length ? values.reduce((a, b) => a + b, 0) : null;
    };
    const activeCount = (items) => verified(items).filter((m) => m.status !== 4).length;
    const resolvedCount = (items) => verified(items).filter((m) => m.status === 4 || m.dbResolved === true).length;

    let positions = {
      v1: { count: 0, wallets: new Set(), staked: 0 },
      v2: { count: 0, wallets: new Set(), staked: 0 },
    };
    try {
      const p = await loadPositions(window.sb, dbMarkets);
      positions = {
        v1: { count: p.positions.v1, wallets: p.wallets.v1, staked: p.staked.v1 },
        v2: { count: p.positions.v2, wallets: p.wallets.v2, staked: p.staked.v2 },
      };
    } catch {
      errors.push("Position history is unavailable from the public Supabase mirror.");
    }

    const combinedMarkets = readings.filter((m) => m.exists !== false);
    const combinedUnique = new Map();
    for (const m of combinedMarkets) {
      const key = `${m.version}:${m.marketAddress.toLowerCase()}:${m.marketId}`;
      combinedUnique.set(key, m);
    }

    render({
      rpcOk: true,
      latestBlock,
      updatedAt: new Date().toLocaleTimeString(),
      v1: {
        items: byVersion.v1.length,
        readable: verified(byVersion.v1).length,
        onchainStake: stakeSum(byVersion.v1),
        markets: byVersion.v1,
        active: activeCount(byVersion.v1),
        resolved: resolvedCount(byVersion.v1),
      },
      v2: {
        items: byVersion.v2.length,
        readable: verified(byVersion.v2).length,
        onchainStake: stakeSum(byVersion.v2),
        markets: byVersion.v2,
        active: activeCount(byVersion.v2),
        resolved: resolvedCount(byVersion.v2),
      },
      combined: {
        items: combinedUnique.size,
        active: activeCount([...combinedUnique.values()]),
        resolved: resolvedCount([...combinedUnique.values()]),
        markets: [...combinedUnique.values()],
      },
      positions,
      errors,
    });
  }

  window.GeomacroChainLive = { CONFIG, load };

  function boot() {
    if (!window.ethers || !window.sb) {
      console.error("[onchain] ethers or Supabase client missing");
      return;
    }
    load().catch((err) => console.error("[onchain] fatal:", err));
    setInterval(() => load().catch((err) => console.error("[onchain] refresh:", err)), CONFIG.refreshMs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
