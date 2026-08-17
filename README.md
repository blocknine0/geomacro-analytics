# Geomacro Analytics

A live system-health dashboard for [Geomacro](https://geomacro.live) — a real-time view into how the autonomous onchain risk pipeline is actually running, pulled straight from production and refreshed on every page load.

**Live:** https://blocknine0.github.io/geomacro-analytics/

## What this shows

Geomacro ingests raw geopolitical and macro news, scores it with an LLM, spins up a tradeable event contract, and settles it onchain, all without a human touching any step. This dashboard exposes that pipeline's real numbers across five areas:

- **News ingestion** — events ingested and how many convert into markets, broken down by category (geopolitics, macro, rare earth, crypto)
- **Market lifecycle** — markets created, AI verdicts issued, markets finalized, and resolution rate
- **Hawk vs. Dove briefings** — average conviction scores from the two AI agents that argue opposite cases before each market opens, plus the final verdict split
- **AI-jury disputes** — disputes raised and resolved on AgentArenaV2's onchain jury system, and votes cast
- **Onchain settlement** — total positions, unique wallets, total USDC staked, and the Hawk/Dove stake split

A separate onchain panel reads the V1 and V2 contracts directly and independently, side by side, plus a combined protocol view — see "Live onchain coverage" below.

## Data source

Everything is queried live, client-side, from Geomacro's production Supabase project via a public, read-only anon key (RLS-scoped to `SELECT` only; no write access is possible with this key). Nothing on this page is sampled, mocked, or estimated. This dashboard reads both onchain contracts directly: the legacy [V1 AgentArena](https://testnet.arcscan.app/address/0xC026fDFC40Dcd8F07b6ecFA21b2BF8400Db0FADe) and the active [V2 AgentArenaV2 proxy](https://testnet.arcscan.app/address/0x2F874FB07084a22D2bB314D0762Af57Cb1856868) — see "Live onchain coverage" below.

## Stack

A single static `index.html` — vanilla JS, the Supabase JS client (via CDN), no build step. Deployed via GitHub Pages.

## Related

- [Geomacro app](https://geomacro.live)
- [Geomacro source](https://github.com/blocknine0/geomacro)
- [X / Twitter](https://x.com/GeomacroLive)

## Live onchain coverage

The analytics page reads Arc Testnet market state from both the legacy V1 AgentArena and the V2 AgentArenaV2 proxy, independently and side by side, plus a combined protocol total. V1 coverage is verified against the production event index and live contract reads. V2 historical discovery starts at deployment block 56797869. V1 has no dispute mechanism — every dispute shown, present or future, will be a V2 market; V2's 5-member AI jury (4-of-5 votes to overturn) is live and active on Arc Testnet.
