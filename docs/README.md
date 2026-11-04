# Keel Desktop — documentation

Everything about the desktop shell, the offline layer, and the sales write path.

## Status at a glance

| Area | State | Where |
|---|---|---|
| Tauri shell + local bundle | **Done** | [SETUP](SETUP.md), [ARCHITECTURE](ARCHITECTURE.md) |
| Build / sync / installers | **Done** | [SETUP](SETUP.md) |
| CI release (tag -> installer + release) | **Done** | [SETUP](SETUP.md#ci-releases), [RUNBOOK](RUNBOOK.md#ship-via-ci) |
| Nightly canary against Keel `main` | **Done** | [`../README.md`](../README.md#the-keel-contract) |
| Auto-updates (minisign + `latest.json`) | **Done** | [`../README.md`](../README.md#auto-updates) |
| Compile gate on every push | **Done** | [SETUP](SETUP.md#ci-releases) |
| Offline session + settings + reads | **Done** | [OFFLINE](OFFLINE.md) |
| Offline sales (outbox + `log_sale`) | **Done** | [OFFLINE-SALES-PLAN](OFFLINE-SALES-PLAN.md) |
| Desktop-native behaviours (print, links, downloads, camera, deep-link reload) | **Unverified** | [ROADMAP](ROADMAP.md) |
| Write-path study (all 119 call sites) | **Done** | [WRITE-PATHS](WRITE-PATHS.md) |
| Expenses / stock / orders / invoices offline | **Not started** | [ROADMAP](ROADMAP.md) |
| Dashboard/Reports pending overlay | **Not started** | [ROADMAP](ROADMAP.md) |
| Full E2E sync against a throwaway shop | **Pending** | [RUNBOOK](RUNBOOK.md) |

## Reading order

1. [`../README.md`](../README.md) — what this repo is, commands, artifacts.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the shell, reads and writes fit together.
3. [`SETUP.md`](SETUP.md) — prerequisites, dev, build, configuration.
4. [`OFFLINE.md`](OFFLINE.md) — the read layer (session, settings, IndexedDB cache).
5. [`OFFLINE-SALES-PLAN.md`](OFFLINE-SALES-PLAN.md) — the `log_sale` contract, outbox, pending UI.
6. [`WRITE-PATHS.md`](WRITE-PATHS.md) — the full study of every write surface and what can/cannot be queued.
7. [`RUNBOOK.md`](RUNBOOK.md) — apply/verify the migration, test offline, debug the cache/outbox, rebuild.
8. [`ROADMAP.md`](ROADMAP.md) — what is next and the decisions still open.
9. [`SESSION-LOG.md`](SESSION-LOG.md) — dated build log with commits and evidence.

## Where code lives

| Concern | Repository / path |
|---|---|
| Pages, styles, data access, offline layer, RPC migration | `../keel` (the web app) |
| Tauri shell, sync script, packaging | this repo |
| Server function `log_sale` | `../keel/supabase/migrations/20261102_add_log_sale_rpc.sql` |
| Desktop docs | `docs/` here |

**Rule:** pages are only ever written in `../keel`. This repo is packaging plus
the sync script. The only desktop-specific transforms are in
`scripts/sync-web.mjs` (asset filename normalisation).

## Fast commands

```bash
pnpm install
pnpm sync        # build ../keel and refresh ./dist
pnpm tauri dev   # run the desktop app
pnpm build       # sync + release + MSI/NSIS
```

## Current known gaps

- Pending sales are shown in the Sales list, but **Dashboard and Reports still
  exclude them**. They need an overlay or an explicit "excludes N pending" note.
- The RPC is SQL-tested and the outbox is unit-tested, but the **full sync loop
  has not been run against a throwaway live shop**.
- Expenses, stock adjustments, orders and invoices still require the network.
- `create_invoice` / `record_invoice_payment` trust caller ids and bypass RLS
  (`SECURITY DEFINER`). Pre-existing; must be fixed with the invoice RPC work.
- The full Vitest suite exceeds 10 minutes on this machine; only the focused
  sales slice is routinely run.
