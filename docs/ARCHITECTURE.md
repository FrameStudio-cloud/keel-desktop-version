# Architecture

## 1. System context

Keel is a React dashboard backed by Supabase. The desktop app is a **Tauri v2
shell** around the built dashboard; it is not a second implementation.

```
┌─────────────────────────────┐
│ ../keel (React + Vite)      │  pages, styles, data access, offline layer
│  - src/pages, src/lib, ...  │
│  - supabase/migrations      │  server-side functions, including log_sale
└──────────────┬──────────────┘
               │ pnpm exec vite build
               ▼
        ../keel/dist
               │ scripts/sync-web.mjs (copy + normalise filenames)
               ▼
      keel-desktop/dist
               │ tauri build (embeds dist into the executable)
               ▼
        Keel.exe / MSI / NSIS
```

At runtime the Tauri window loads `dist` from disk. There is **no remote URL and
no `devUrl`**: `src-tauri/tauri.conf.json` sets `build.frontendDist: "../dist"`.
The shell therefore opens even with no internet.

> **Origins matter.** Tauri dev serves the bundle from a local asset server
> (`http://127.0.0.1:1430`); the release app uses the Tauri asset protocol
> (`http://tauri.localhost` on Windows). `localStorage` and IndexedDB are
> per-origin, so the dev and release profiles do **not** share a session or a
> cache. A release build needs one online launch to populate its own cache.

## 2. Build and runtime layers

| Layer | Owner | What it does |
|---|---|---|
| Pages / components | `../keel` | All UI and data access |
| Offline reads | `../keel/src/lib/offline` | Session, shop id, settings snapshot, query cache |
| Offline writes | `../keel/src/lib/offline/salesOutbox.js` | Durable sale outbox |
| Server functions | `../keel/supabase/migrations` | `log_sale` and existing RPCs |
| Shell | this repo | Tauri config, Rust entry point, icons |
| Sync | `scripts/sync-web.mjs` | Build keel, replace `dist`, normalise space names |
| Packaging | Tauri CLI | MSI + NSIS |

## 3. Offline read layer

Enabled by `offlineEnabled()` (`src/lib/offline/flag.js`): true inside Tauri, or
when `VITE_OFFLINE_CACHE=1` is set for browser testing. The deployed web app is
otherwise unchanged.

```
AuthContext          localStorage session (existing)
getShopId()          localStorage shop id per auth user, revalidated in background
SettingsProvider     IndexedDB snapshot -> apply -> network refresh -> save
useOfflineQuery      IndexedDB snapshot -> React Query -> Supabase
OfflineIndicator     navigator.onLine + last cache timestamp
```

- **Session:** `getAccessToken()` keeps the persisted session when a refresh
  fails for a network reason; only a real rejection from the auth server clears
  it. This is what lets the app open offline.
- **Identity:** `shop_id` is cached per auth user and returned immediately; the
  `users` row is revalidated in the background.
- **Settings:** the mapped settings object is cached under
  `keel:offline:settings:<shopId>` and applied **before** the network. A blocked
  request can take ~15s to fail; waiting for it left protected pages blank.
- **Reads:** `useOfflineQuery` hydrates a query from `rq:<queryKey>` with its
  original timestamp, then revalidates normally. Only successful results are
  cached; a failed read throws so it cannot overwrite a good page with `[]`.
- **Cached today:** Overview (`dashboardSummary`), Inventory (products,
  catalogue, attributes), Sales list, and the settings snapshot.

See [OFFLINE.md](OFFLINE.md) for cache keys and verification.

## 4. Offline write layer (sales)

```
commitProductSales()
  ├── online  -> supabase.rpc("log_sale", {...})
  │              └── one PostgreSQL transaction:
  │                    advisory lock on batch_id
  │                    insert sales rows
  │                    stock = stock - quantity
  │                    return { sales, low_stock }
  │
  └── offline / network error
        -> IndexedDB outbox item (id = sale:<batch_id>)
              -> Sales page shows a pending row
              -> reconnect / app start -> processSalesOutbox()
                    -> log_sale
                    -> delete outbox item
                    -> alert low stock
                    -> refresh the Sales query
```

### `log_sale`

`supabase/migrations/20261102_add_log_sale_rpc.sql`

```
log_sale(p_shop_id, p_batch_id, p_items, p_method, p_mpesa_code,
         p_created_by, p_created_at) -> jsonb
```

- `SECURITY DEFINER` (bypasses RLS), so it resolves the caller from `auth.uid()`
  → `users`, and rejects a `p_shop_id` that is not the caller's shop.
- `p_batch_id` is the idempotency key, guarded by
  `pg_advisory_xact_lock(hashtextextended(...))` and an existence check.
- One `sales` row per item; stock is a delta, never absolute.
- `p_created_by` is used only when that user belongs to the shop; otherwise the
  caller. This preserves the seller on an offline sale synced by someone else.
- `p_created_at` is the sale time, not the sync time, so the day's totals land
  in the right day.
- Returns `low_stock` for the client to invoke the existing low-stock email.
- Grants: `authenticated` only. `anon` and `service_role` are false.
- A partially applied legacy batch raises instead of being silently skipped.

### Pending rows

`usePendingSales()` reads the outbox and returns sale-shaped rows (plus
`_pending` and `_pending_status`). The Sales page merges them on page 0 with no
search, groups them by `batch_id` exactly like server rows, and shows:

- **Pending sync** (amber) while waiting.
- **Sync failed** (red) for a permanent rejection; a Retry button appears.
- **Sign in to sync** (red) when the token is rejected.

The receipt is local and prints **PENDING SYNC** when the sale was queued. The
inventory query cache is decremented immediately so the till's stock guard stays
honest.

## 5. Security boundaries

| Boundary | Enforcement |
|---|---|
| Shop isolation on direct reads/writes | RLS policies (`shop_id = users.shop_id` for `auth.uid()`) |
| Shop isolation inside `log_sale` | Function derives the shop from `auth.uid()`; rejects a mismatched `p_shop_id` |
| Staff attribution | `p_created_by` accepted only if that `users` row belongs to the shop |
| Function grants | `revoke` from `public, anon, service_role`; grant to `authenticated` only |
| Client identity | Shop id passed by the client is a hint, never trusted |

⚠️ Pre-existing gap, not introduced here: `create_invoice` trusts
`p_payload->>'shop_id'` and `record_invoice_payment` selects an invoice by id
without checking the caller's shop. Both are `SECURITY DEFINER`, so RLS does not
protect them. The new `log_sale` deliberately does not repeat this pattern. The
invoice RPCs should be fixed with the invoice offline work.

## 6. File map

### Desired shell / packaging (this repo)

| File | Role |
|---|---|
| `scripts/sync-web.mjs` | Build `../keel`, replace `dist`, normalise space filenames |
| `src-tauri/tauri.conf.json` | Product name, identifier, `frontendDist`, window |
| `src-tauri/src/main.rs`, `lib.rs` | Tauri scaffold |
| `src-tauri/icons/` | Bundle icons |
| `package.json` | `sync`, `build`, `tauri` scripts |

### Offline reads (`../keel`)

| File | Role |
|---|---|
| `src/lib/offline/flag.js` | `isDesktop`, `offlineEnabled` |
| `src/lib/offline/db.js` | IndexedDB `cache` + `outbox` stores (v2) |
| `src/lib/offline/identity.js` | Shop id + settings snapshot |
| `src/lib/offline/queryCache.js` | `useOfflineQuery`, cache write tracking |
| `src/components/OfflineIndicator.jsx` | Offline pill |
| `src/hooks/useOnlineStatus.js` | Online/offline events |
| `src/lib/supabase.js` | Session survives network-refresh failure |
| `src/lib/shop.js` | Cached shop id |
| `src/context/AuthContext.jsx` | Does not create a shop on a failed read |
| `src/context/SettingsProvider.jsx` | Snapshot-first settings |
| `src/hooks/useInventory.js`, `useSales.js`, `useDashboardSummary.js` | Cached queries |

### Offline sales (`../keel`)

| File | Role |
|---|---|
| `supabase/migrations/20261102_add_log_sale_rpc.sql` | `log_sale` |
| `src/lib/offline/salesOutbox.js` | Enqueue, process, retry, legacy adoption |
| `src/lib/offline/inventoryCache.js` | Optimistic stock decrement |
| `src/lib/saleWriter.js` | `commitProductSales` |
| `src/lib/writeQueue.js` | Legacy queue; `getLegacySales` / `removeLegacySales` |
| `src/components/LogSaleModal.jsx`, `SalesTill.jsx` | Callers |
| `src/pages/Sales.jsx` | Pending rows, badges, retry |
| `src/hooks/usePendingSales.js` | Outbox to UI |
| `src/components/ReceiptModal.jsx` | PENDING SYNC note |
| `src/main.jsx` | Start the outbox before the old queue |

## 7. Design principles

1. **One sale, one transaction.** The database owns the sale + stock invariant.
2. **Idempotency by the cart's `batch_id`.** A replay is a no-op, not a duplicate.
3. **Stock is always a delta.** Absolute values lose a concurrent sale.
4. **Never cache a failed read.** A failure must not become an empty page.
5. **Load identity/settings before the network.** A blocked request can hang.
6. **A network failure is not an auth failure.** Only a real 401 clears the session.
7. **The cache is a fallback, not a second source of truth.** Online reads always
   revalidate.
8. **The desktop owns the packaging and the outbox; the server owns the write.**
   Both surfaces share the RPC.
9. **Do not silently invent success.** A permanent rejection is thrown and shown,
   not queued as if it worked.

## 8. Deliberate limitations

- **No offline writes outside sales.** Expenses, stock adjustments, orders and
  invoices still require the network.
- **Oversell is allowed.** Stock may go negative; the sale is never rejected after
  the customer has left.
- **Pending sales are only on page 0 with no search.** A server-filtered list has
  no way to know a pending row matches the search.
- **Dashboard/Reports exclude pending sales.** They are server-side aggregates.
  A notice or overlay is next.
- **First-ever login needs the internet.** Only a previously signed-in session
  can open offline.
- **Dev and release caches are separate** (different origins).
- **The outbox is not gated to desktop.** On the web it also queues a sale on a
  network failure; the read cache remains Tauri-only.
- **Settings/config/social remain online-only** in this phase.
