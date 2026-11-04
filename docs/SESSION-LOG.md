# Session log

Dated record of what was built, verified and shipped. Code changes in `../keel`
are intentionally **uncommitted**; desktop commits are listed.

## 2 Nov 2026 — Desktop shell and packaging

- Created `keel-desktop` as its own git repo; `.gitignore` covers
  `node_modules`, `dist`, `src-tauri/target`, `target`, logs, env.
- Prerequisites: Node 24.14.0, pnpm 11.8.0, Rust 1.97.0, Tauri CLI 2.12.4 via
  the `@tauri-apps/cli` devDependency.
- Scaffolded Tauri v2 (vanilla, pnpm).
- Configured:
  - `productName: "Keel"`
  - `identifier: "keel.framestudio.co.ke"`
  - `build.frontendDist: "../dist"` (no remote URL)
  - window 1280×800, title Keel, `withGlobalTauri: true`.
- `scripts/sync-web.mjs`: build `../keel`, replace `dist`, fail loudly, normalise
  space-containing asset filenames; `pnpm build` runs sync first.
- Verified dev `/login` in a fresh WebView profile; built MSI + NSIS; launched
  the release exe.
- Commits:
  - `398913b` Scaffold Tauri v2 desktop app (Keel)
  - `b0687ce` Set Keel identifier and lock Rust dependencies
  - `48de88a` Normalise space-containing asset names when syncing the web bundle

**Issues found and fixed**
- The first release compile took 19m 16s (one-time Rust).
- NSIS was outdated; Tauri recreated it.
- Asset filenames with spaces resolved to `index.html` on the Tauri asset server;
  the sync now renames 18 files and rewrites references.
- A fresh WebView profile showed the landing page; the existing profile restored
  a session. Both are expected.
- WebView2's debug port bound to IPv6; CDP needed `[::1]`.

## 2 Nov 2026 — Offline reads

- Session: `getAccessToken` keeps the persisted session on a network failure;
  only a real auth rejection clears it.
- `getShopId`: cached per auth user in localStorage, revalidated in the
  background.
- Settings: IndexedDB snapshot applied before the network, refreshed after,
  saved on success.
- Reads: `useOfflineQuery` hydrates from IndexedDB with the original timestamp;
  only successful results are cached.
- `AuthContext.ensureUserRecordsInner` throws on a failed `users` read instead of
  falling through to shop creation.
- `OfflineIndicator` + `useOnlineStatus`.
- Cold-start test: blocked `*.supabase.co`, reloaded with empty React Query
  memory; Inventory still showed 5 products and Settings showed
  `OLFATTA / Laundry Pro Live`. The pill showed "Offline — showing saved data".
- 42 focused tests; lint 0 on touched files.
- Desktop commit:
  - `c37104e` Document setup, sync flow, and offline v1

**The key bug found in review:** settings were only loaded in the catch, and a
blocked request takes ~15s to fail, so protected pages sat on the loading screen
for 15s. The snapshot is now applied on mount.

## 2 Nov 2026 — Write-path study

- Scanned 119 client write call sites across `src`.
- Read the queue, sale writer, Finance, serviceData, invoices, settings, website,
  social and notifications.
- Inspected the live database: columns, constraints, indexes, triggers, RPC
  definitions and RLS policies.
- Findings:
  - The old `writeQueue` is localStorage, gives up after 5 retries, has no
    `online` listener, no idempotency, and writes absolute stock.
  - Sales are the right first slice; orders/invoices need RPCs.
  - Client uuids are already supported; `customers` has `(shop_id, phone)` unique;
    `service_orders` allocates `order_number`; `create_invoice` allocates
    `number_seq` without a lock and is not idempotent.
  - `create_invoice` and `record_invoice_payment` do not verify shop ownership.
  - Historical docs show the sale path is a legacy of the original no-RLS,
    direct-write architecture; `assistant_log_sale` and the removed
    `add_credit_charge` already used the atomic pattern.
- Desktop commit:
  - `9590db5` Study Keel write paths before offline writes

## 2 Nov 2026 — Offline sales

**Decisions:** sales only; `log_sale` approved; pending rows merged; oversell
allowed with a warning.

**Database**
- `supabase/migrations/20261102_add_log_sale_rpc.sql` applied live.
- `log_sale`: one transaction, idempotent by `batch_id` (advisory lock),
  `stock = stock - qty`, auth-derived shop, validated seller attribution,
  sale-time `created_at`, authenticated-only grants.
- A legacy partial batch raises instead of being silently completed.
- Verified twice in a rollback transaction: one row, one decrement,
  `already_applied` on replay. Grants: authenticated true, anon/service_role
  false.

**Client**
- `commitProductSales`: RPC online, durable outbox on network failure, throw on
  permanent rejection.
- IndexedDB `outbox` (DB v2), one item per cart, `id = sale:<batch_id>`.
- Retry on `online`, `needs_auth` pause, `failed` + manual retry, legacy
  per-line sales adopted and removed only after they are safely queued.
- Sales page: pending rows on page 0 with no search, grouped by `batch_id`,
  Pending sync / Sync failed / Sign in to sync badges, "N pending sync" pill.
- Receipt prints **PENDING SYNC**; inventory cache is decremented immediately.

**Verification**
- Live desktop: network blocked, a real sale logged, pending row + receipt +
  outbox item observed; outbox cleared before reconnecting, so the live shop has
  0 rows for the test batch.
- 26 focused tests: saleWriter 9, salesOutbox 5, Sales 6, Inventory 6.
- Lint 0.

**Release**
- Final build 16:39; MSI 16.87 MiB, NSIS 16.36 MiB, exe 19,990,528 bytes.
- The release app launched successfully.

**Desktop commit**
- `13eaac5` Document and implement the offline sales slice

**Not done**
- Full sync loop against a throwaway live shop.
- Dashboard/Reports pending overlay.
- Expenses, stock, orders, invoices offline.
- Invoice RPC shop-ownership fix.

## Keel repo changes (uncommitted)

```
 AGENTS.md
 src/App.jsx
 src/components/LogSaleModal.jsx
 src/components/ReceiptModal.jsx
 src/components/SalesTill.jsx
 src/context/AuthContext.jsx
 src/context/SettingsProvider.jsx
 src/hooks/useDashboardSummary.js
 src/hooks/useInventory.js
 src/hooks/useSales.js
 src/lib/saleWriter.js
 src/lib/saleWriter.test.js
 src/lib/shop.js
 src/lib/supabase.js
 src/lib/writeQueue.js
 src/main.jsx
 src/pages/Sales.jsx
 src/components/OfflineIndicator.jsx          (new)
 src/hooks/useOnlineStatus.js                (new)
 src/hooks/usePendingSales.js                (new)
 src/lib/offline/                            (new)
 supabase/migrations/20261102_add_log_sale_rpc.sql (new)
```

Keel-side documentation added:
- `docs/keel-ecosystem/Features (Keel)/Offline Desktop.md`
- `docs/keel-ecosystem/Features (Keel)/Sales & Receipts.md` (updated)
- `docs/keel-ecosystem/Features (Keel)/Inventory & Stock.md` (updated)
- `docs/keel-ecosystem/Supabase/RPC Functions.md` (added `log_sale`)
- `docs/keel-ecosystem/Supabase/Migrations.md` (added the migration)
- `AGENTS.md` (two session entries)

## 4 Nov 2026 - Release pipeline, canary, and the shell/Keel contract

Added to this repo:
- `scripts/stamp-version.mjs` - tag version into `tauri.conf.json` and `Cargo.toml`.
- `.github/workflows/release.yml` - `v*` tag builds Keel + shell and publishes MSI/NSIS with a `BUILD-INFO.txt` naming the Keel commit.
- `.github/workflows/canary.yml` - nightly build against Keel `main`.
- `scripts/canary.mjs` - bundle contract checks plus a Chromium render of five routes with `__TAURI_INTERNALS__` injected.
- `KEEL_ROOT` in `scripts/sync-web.mjs` so the Keel checkout does not have to be the sibling folder.

Verified:
- Deep links are safe. `tauri-2.12.5/src/manager/mod.rs::get_asset` falls back `exact -> path.html -> path/index.html -> index.html`, so `/inventory` on reload serves `index.html` and `BrowserRouter` takes over. ROADMAP updated.

Found by the first canary run (both were live desktop-only bugs):
- `@vercel/analytics` and `@vercel/speed-insights` request `/_vercel/...`; Tauri's fallback served `index.html` as JS, throwing an uncaught `SyntaxError` on every load.
- `src/main.jsx` registered `/sw.js` unconditionally; WebView2 keeps a persistent profile, so the shell cache would serve stale UI after a sync.

Both fixed in `keel/src/main.jsx` behind the existing `isDesktop()` flag, so web behaviour is unchanged.
