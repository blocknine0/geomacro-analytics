/* Geomacro live V1/V2 onchain reader
 * Read-only. No wallet, no private key, no contract writes.
 * V1 = legacy AgentArena
 * V2 = AgentArenaV2 behind ERC1967 proxy
 */
(function () {
  "use strict";

  const CONFIG = {
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    v1: {
      version: "v1",
      address: "0xC026fDFC40Dcd8F07b6ecFA21b2BF8400Db0FADe",
      fromBlock: 0,
    },
    v2: {
      version: "v2",
      address: "0x2F874FB07084a22D2bB314D0762Af57Cb1856868",
      implementation: "0x96DDb29e27bdc3edf0c27bf885840Ebf8151DA7c",
      fromBlock: 56797869,
    },
    // Keep RPC requests bounded for public Arc RPC.
    logChunk: 20000,
    concurrency: 8,
    maxMarkets: 2000,
    refreshMs: 5 * 60 * 1000,
  };

  const ABI = [
    "function getMarket(string marketId) view returns (uint8 status, uint256 hawkTotal, uint256 doveTotal, bool exists)",
    "function getMarketFullDetails(string marketId) view returns (uint8 status, uint8 winner, uint8 tentativeWinner, uint256 stakingEndTime, uint256 resolutionTime, uint256 aiResolutionTime, address disputer, uint256 disputeBond, uint256 disputeRaisedAt)",
    "event MarketCreated(string marketId, uint256 stakingEndTime, uint256 resolutionTime)",
    "event Staked(string marketId, address indexed user, uint8 side, uint256 amount)"
  ];

  const V1_ABI = [
    "function getMarket(string marketId) view returns (uint8 status, uint256 hawkTotal, uint256 doveTotal, bool exists)",
    "function getMarketFullDetails(string marketId) view returns (uint8 status, uint8 winner, uint8 tentativeWinner, uint256 stakingEndTime, uint256 resolutionTime, uint256 aiResolutionTime, address disputer)",
    "event MarketCreated(string marketId, uint256 stakingEndTime, uint256 resolutionTime)",
    "event Staked(string marketId, address indexed user, uint8 side, uint256 amount)"
  ];

  const V2_ABI = ABI;

  function shortAddress(a) {
    if (!a) return "—";
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
  }

  function fmt(n, digits = 0) {
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function usdc(value) {
    try { return Number(ethers.formatUnits(value, 18)); } catch { return null; }
  }

  function statusName(status) {
    return ["OPEN", "LOCKED", "AI_RESOLVED", "DISPUTED", "FINALIZED"][Number(status)] || `STATUS_${status}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function getLatestBlock(provider) {
    return provider.getBlockNumber();
  }

  async function queryInChunks(contract, filter, fromBlock, toBlock) {
    const out = [];
    if (fromBlock > toBlock) return out;

    for (let start = fromBlock; start <= toBlock; start += CONFIG.logChunk) {
      const end = Math.min(toBlock, start + CONFIG.logChunk - 1);
      let rows = [];
      try {
        rows = await contract.queryFilter(filter, start, end);
      } catch (firstErr) {
        // Retry with a smaller window. Public RPCs can reject large eth_getLogs ranges.
        const half = Math.max(1000, Math.floor(CONFIG.logChunk / 4));
        for (let s = start; s <= end; s += half) {
          const e = Math.min(end, s + half - 1);
          try {
            rows.push(...await contract.queryFilter(filter, s, e));
          } catch (err) {
            console.warn("[onchain] log range failed", s, e, err);
          }
        }
      }
      out.push(...rows);
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
          result[i] = { error: err };
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
      .order("id", { ascending: true })
      .limit(CONFIG.maxMarkets);

    if (error) throw error;

    return (data || []).map(row => ({
      marketId: `mkt_${row.id}`,
      eventId: row.id,
      version: String(row.market_address || "").toLowerCase() === CONFIG.v2.address.toLowerCase() ? "v2" : "v1",
      marketAddress: row.market_address || CONFIG.v1.address,
      title: row.market_question || row.title || null,
      createdAt: row.created_at || null,
      dbResolved: row.market_resolved === true
    }));
  }

  async function loadV2Created(provider) {
    const contract = new ethers.Contract(CONFIG.v2.address, V2_ABI, provider);
    const latest = await getLatestBlock(provider);
    const events = await queryInChunks(contract, contract.filters.MarketCreated(), CONFIG.v2.fromBlock, latest);

    const byId = new Map();
    for (const ev of events) {
      const marketId = ev.args?.[0];
      if (!marketId) continue;
      byId.set(String(marketId), {
        marketId: String(marketId),
        version: "v2",
        marketAddress: CONFIG.v2.address,
        createdAt: null,
        eventBlock: ev.blockNumber
      });
    }
    return [...byId.values()];
  }

  async function readMarket(provider, item) {
    const abi = item.version === "v2" ? V2_ABI : V1_ABI;
    const contract = new ethers.Contract(item.marketAddress, abi, provider);

    try {
      const basic = await contract.getMarket(item.marketId);
      let full = null;
      try { full = await contract.getMarketFullDetails(item.marketId); } catch {}

      return {
        ...item,
        exists: Boolean(basic[3]),
        status: Number(basic[0]),
        statusLabel: statusName(basic[0]),
        hawkTotalRaw: basic[1].toString(),
        doveTotalRaw: basic[2].toString(),
        hawkTotal: usdc(basic[1]),
        doveTotal: usdc(basic[2]),
        totalStaked: (usdc(basic[1]) ?? 0) + (usdc(basic[2]) ?? 0),
        winner: full ? Number(full[1]) : null,
        tentativeWinner: full ? Number(full[2]) : null,
        stakingEndTime: full ? Number(full[3]) : null,
        resolutionTime: full ? Number(full[4]) : null,
        aiResolutionTime: full ? Number(full[5]) : null,
        disputer: full ? full[6] : null,
        disputeBond: full && full.length > 7 ? usdc(full[7]) : null,
        disputeRaisedAt: full && full.length > 8 ? Number(full[8]) : null
      };
    } catch (error) {
      return { ...item, exists: null, error: error.message || String(error) };
    }
  }

  async function loadPositions(sb, markets) {
    const { data, error } = await sb
      .from("positions")
      .select("wallet_address,market_id,side,staked_amount_raw")
      .limit(10000);

    if (error) return { rows: [], error };

    const byEventId = new Map();
    for (const m of markets) {
      if (m.eventId != null) byEventId.set(String(m.eventId), m.version);
    }

    const wallets = { v1: new Set(), v2: new Set() };
    const positions = { v1: 0, v2: 0 };
    const staked = { v1: 0, v2: 0 };

    for (const row of data || []) {
      const version = byEventId.get(String(row.market_id));
      if (!version) continue;
      positions[version]++;
      if (row.wallet_address) wallets[version].add(row.wallet_address.toLowerCase());
      try { staked[version] += Number(ethers.formatUnits(row.staked_amount_raw || "0", 18)); } catch {}
    }

    return {
      rows: data || [],
      positions,
      wallets,
      staked,
      error: null
    };
  }

  function ensureSection() {
    let el = document.getElementById("onchain-live-section");
    if (el) return el;

    const content = document.getElementById("content");
    if (!content) return null;

    el = document.createElement("section");
    el.id = "onchain-live-section";
    el.innerHTML = `
      <div class="section-head">
        <h2><span class="h2-icon" style="background:rgba(56,189,248,0.12);color:var(--dove);">◈</span> V1 + V2 live onchain</h2>
      </div>
      <p class="subtitle" id="onchain-subtitle">Read-only verification against Arc Testnet. No wallet or write operation is used.</p>
      <div class="grid" id="onchain-summary-grid"></div>
      <div class="card" style="margin-top:16px;">
        <div class="card-label">Market coverage</div>
        <div id="onchain-market-table" style="overflow:auto;"></div>
      </div>
      <div class="empty-note" id="onchain-warning" style="display:none;margin-top:12px;"></div>
    `;
    content.insertBefore(el, content.firstElementChild);
    return el;
  }

  function render(summary) {
    const section = ensureSection();
    if (!section) return;

    const grid = document.getElementById("onchain-summary-grid");
    const table = document.getElementById("onchain-market-table");
    const warning = document.getElementById("onchain-warning");
    const subtitle = document.getElementById("onchain-subtitle");

    const card = (label, value, hint = "") => `
      <div class="card tone-neutral">
        <div class="card-label">${label}</div>
        <div class="card-value">${value}</div>
        <div class="card-hint">${hint}</div>
      </div>`;

    grid.innerHTML =
      card("V1 markets", fmt(summary.v1.marketCount), `${fmt(summary.v1.liveCount)} currently readable`) +
      card("V2 markets", fmt(summary.v2.marketCount), `${fmt(summary.v2.liveCount)} currently readable`) +
      card("Combined markets", fmt(summary.combined.marketCount), "V1 + V2, deduplicated by version + address + market ID") +
      card("V1 onchain stake", summary.v1.totalStaked == null ? "—" : `${fmt(summary.v1.totalStaked, 2)} USDC`, "getMarket() totals") +
      card("V2 onchain stake", summary.v2.totalStaked == null ? "—" : `${fmt(summary.v2.totalStaked, 2)} USDC`, "getMarket() totals") +
      card("Indexed wallets", `${summary.positions.v1.wallets.size + summary.positions.v2.wallets.size}`, "Supabase position mirror; version classified by market") +
      card("Chain health", summary.rpcOk ? "LIVE" : "ERROR", `Arc Testnet · block ${summary.latestBlock ?? "—"}`);

    const rows = summary.markets
      .filter(m => m.exists !== false)
      .sort((a,b) => (a.version + a.marketId).localeCompare(b.version + b.marketId))
      .slice(0, 100);

    table.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:10px;border-bottom:1px solid var(--line);">Version</th>
            <th style="text-align:left;padding:10px;border-bottom:1px solid var(--line);">Market</th>
            <th style="text-align:left;padding:10px;border-bottom:1px solid var(--line);">Status</th>
            <th style="text-align:right;padding:10px;border-bottom:1px solid var(--line);">Hawk</th>
            <th style="text-align:right;padding:10px;border-bottom:1px solid var(--line);">Dove</th>
            <th style="text-align:right;padding:10px;border-bottom:1px solid var(--line);">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(m => `
            <tr>
              <td style="padding:9px 10px;border-bottom:1px solid var(--line);font-weight:700;">${m.version.toUpperCase()}</td>
              <td style="padding:9px 10px;border-bottom:1px solid var(--line);">${escapeHtml(m.marketId)}</td>
              <td style="padding:9px 10px;border-bottom:1px solid var(--line);">${escapeHtml(m.statusLabel || (m.error ? "UNAVAILABLE" : "—"))}</td>
              <td style="padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;">${m.hawkTotal == null ? "—" : fmt(m.hawkTotal,2)}</td>
              <td style="padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;">${m.doveTotal == null ? "—" : fmt(m.doveTotal,2)}</td>
              <td style="padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;">${m.totalStaked == null ? "—" : fmt(m.totalStaked,2)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      ${rows.length >= 100 ? `<div class="empty-note" style="margin-top:10px;">Showing first 100 readable markets. Aggregate metrics include all discovered markets.</div>` : ""}
    `;

    if (summary.errors.length) {
      warning.style.display = "block";
      warning.textContent = summary.errors.join(" · ");
    } else if (summary.markets.some(m => m && m.error)) {
      warning.style.display = "block";
      warning.textContent = "Some discovered markets could not be read from chain; affected aggregates remain unavailable.";
    } else {
      warning.style.display = "none";
    }

    subtitle.textContent =
      `Live read-only snapshot · Arc Testnet · block ${summary.latestBlock ?? "—"} · updated ${new Date().toLocaleTimeString()}. ` +
      `V1 ${shortAddress(CONFIG.v1.address)} · V2 proxy ${shortAddress(CONFIG.v2.address)}.`;
  }

  async function load() {
    const errors = [];
    const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });

    let latestBlock = null;
    try {
      latestBlock = await getLatestBlock(provider);
    } catch (e) {
      render({
        rpcOk: false, latestBlock: null,
        v1: { marketCount: 0, liveCount: 0, totalStaked: null },
        v2: { marketCount: 0, liveCount: 0, totalStaked: null },
        combined: { marketCount: 0 },
        positions: { v1: { wallets: new Set() }, v2: { wallets: new Set() } },
        markets: [], errors: ["Arc Testnet RPC unavailable."]
      });
      return;
    }

    let dbMarkets = [];
    try {
      dbMarkets = await loadSupabaseMarkets(window.sb);
    } catch (e) {
      errors.push("Supabase market index unavailable.");
    }

    let v2Created = [];
    try {
      v2Created = await loadV2Created(provider);
    } catch (e) {
      errors.push("V2 MarketCreated history unavailable.");
    }

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
    const readings = await mapLimit(markets, CONFIG.concurrency, m => readMarket(provider, m));

    const good = readings.filter(x => x && !x.error && x.exists !== false);
    const v1Good = good.filter(x => x.version === "v1");
    const v2Good = good.filter(x => x.version === "v2");

    const sum = arr => {
      const vals = arr.map(x => x.totalStaked).filter(Number.isFinite);
      return vals.length ? vals.reduce((a,b) => a+b,0) : null;
    };
    const v1Markets = markets.filter(m => m.version === "v1");
    const v2Markets = markets.filter(m => m.version === "v2");
    const v1ReadableAll = v1Markets.length === v1Good.length;
    const v2ReadableAll = v2Markets.length === v2Good.length;

    let positions = {
      v1: { wallets: new Set(), count: 0, staked: 0 },
      v2: { wallets: new Set(), count: 0, staked: 0 }
    };

    try {
      const p = await loadPositions(window.sb, dbMarkets);
      positions = {
        v1: { wallets: p.wallets.v1, count: p.positions.v1, staked: p.staked.v1 },
        v2: { wallets: p.wallets.v2, count: p.positions.v2, staked: p.staked.v2 }
      };
    } catch {}

    render({
      rpcOk: true,
      latestBlock,
      v1: {
        marketCount: markets.filter(m => m.version === "v1").length,
        liveCount: v1Good.length,
        totalStaked: v1ReadableAll ? sum(v1Good) : null
      },
      v2: {
        marketCount: markets.filter(m => m.version === "v2").length,
        liveCount: v2Good.length,
        totalStaked: v2ReadableAll ? sum(v2Good) : null
      },
      combined: { marketCount: markets.length },
      positions,
      markets: readings,
      errors
    });
  }

  window.GeomacroChainLive = { CONFIG, load };

  function boot() {
    if (!window.ethers || !window.sb) {
      console.error("[onchain] ethers or Supabase client missing");
      return;
    }
    load().catch(err => console.error("[onchain] fatal:", err));
    setInterval(() => load().catch(err => console.error("[onchain] refresh:", err)), CONFIG.refreshMs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
