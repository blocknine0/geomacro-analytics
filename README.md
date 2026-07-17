# Geomacro Analytics

Live system-health dashboard for [Geomacro](https://geomacro.live) = a real-time view into how the autonomous onchain risk pipeline is actually running, pulled straight from production, refreshed on every page load.

**Live:** https://blocknine0.github.io/geomacro-analytics/

## What this shows

Geomacro ingests raw geopolitical/macro news, scores it with an LLM, spins up a tradeable event contract, and settles it onchain — all without a human touching any step. This dashboard exposes that pipeline's real numbers across three stages:

- **News ingestion** = events ingested and how many convert into markets, broken down by category (geopolitics, macro, rare earth, crypto)
- **Market lifecycle** = markets created, AI verdicts issued, markets finalized, and resolution rate
- **Onchain settlement** = total positions, unique wallets, total USDC staked, and the Hawk/Dove split

## Data source

Everything is queried live, client-side, from Geomacro's production Supabase project via a public, read-only anon key (RLS-scoped to `SELECT` only, no write access is possible with this key). Nothing on this page is sampled, mocked, or estimated. The relevant onchain contract is verifiable at [Arc Testnet Explorer](https://testnet.arcscan.app/address/0xC026fDFC40Dcd8F07b6ecFA21b2BF8400Db0FADe).

## Stack

Single static `index.html` = vanilla JS, Supabase JS client (CDN), no build step. Deployed via GitHub Pages.

## Related

- [Geomacro app](https://geomacro.live)
- [Geomacro source](https://github.com/blocknine0/geomacro)
- [X / Twitter](https://x.com/GeomacroLive)
