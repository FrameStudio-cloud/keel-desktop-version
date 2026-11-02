# Offline mode — v1

## Goal

Open the desktop app with no internet, stay signed in, and see the data the shop
last saw. No offline writes in this version.

## Scope

**Included**

- Persisted session survives a failed token refresh.
- Cached `shop_id` and settings snapshot, applied before the network is touched.
- Cached reads for **Overview**, **Inventory** and **Sales**.
- An offline indicator with the time the cache was last written.
- Web deployment behaviour unchanged (the layer is gated on the Tauri runtime).

**Not included (next phase)**

- Queued sales, expenses or stock adjustments.
- Any database change.
- Signing in for the first time without internet.
- Cached reads for Finance, Customers, Orders/Services, Reports, Settings,
  Invoices, Inbox, Assistant or Marketing.
- Conflict resolution between devices.

## Architecture

```
Tauri shell (loads ./dist locally)
  └── Keel React app
        ├── AuthContext        persisted session (localStorage, unchanged)
        ├── getShopId()        cached shop id (localStorage) + background revalidate
        ├── SettingsProvider   snapshot (IndexedDB) first, network refresh second
        └── useOfflineQuery    IndexedDB snapshot → React Query → Supabase
```

The shell itself needs no offline code: Tauri already loads the built bundle from
disk. The offline layer lives inside Keel so the same pages are used on web and
desktop.

## Principles

1. **A network failure is not an authentication decision.** Only a real 401 from
   the refresh endpoint clears the session.
2. **Identity and settings come from disk before the network.** A blocked
   Supabase request can hang for ~15 seconds; waiting for it leaves protected
   pages blank even though the data is local.
3. **Cache successful reads, never failed reads.** Page hooks log and throw on
   error. Resolving `{ rows: [] }` would cache an empty page and erase what the
   owner last saw.
4. **The cache is a fallback, not a second source of truth.** Online reads always
   revalidate; the cached value is shown first with its original timestamp.
5. **Gate on the runtime.** `offlineEnabled()` is true in Tauri or when
   `VITE_OFFLINE_CACHE=1` is set for browser testing. The deployed web app keeps
   its network-first behaviour.

## File map

New (inside `../keel`):

| File | Responsibility |
|---|---|
| `src/lib/offline/flag.js` | `isDesktop()` / `offlineEnabled()` |
| `src/lib/offline/db.js` | tiny IndexedDB key/value store (`keel-offline` / `cache`) |
| `src/lib/offline/identity.js` | cached shop id + settings snapshot |
| `src/lib/offline/queryCache.js` | `useOfflineQuery()` + cache-write subscription |
| `src/components/OfflineIndicator.jsx` | bottom-centre offline pill |
| `src/hooks/useOnlineStatus.js` | `online` / `offline` listener |

Modified:

| File | Change |
|---|---|
| `src/lib/supabase.js` | keep the session on a network-error refresh; clear only on a real rejection |
| `src/lib/shop.js` | return the cached shop id immediately, revalidate in the background |
| `src/context/AuthContext.jsx` | throw on a failed `users` lookup instead of falling through to shop creation |
| `src/context/SettingsProvider.jsx` | hydrate the snapshot on mount; skip the network when offline; save on success; refresh on reconnect |
| `src/hooks/useInventory.js` | cached products / catalogue / attributes; log + throw on error |
| `src/hooks/useSales.js` | cached sales list; log + throw on error |
| `src/hooks/useDashboardSummary.js` | cached dashboard summary |
| `src/App.jsx` | render the offline indicator for signed-in users |

## Data flow

### Online launch

1. `AuthContext` reads the persisted session from localStorage.
2. `getShopId()` returns the cached id and revalidates it.
3. `SettingsProvider` applies the last snapshot (if any), then fetches fresh
   settings, then writes a new snapshot.
4. Page queries hydrate their IndexedDB entries, then fetch fresh data and
   overwrite the cache.

### Offline launch (`navigator.onLine === false`)

1. Session comes from localStorage.
2. Cached shop id is returned immediately.
3. Snapshot is applied; `fetchSettings` returns early because the machine is
   offline.
4. Protected pages render; `useOfflineQuery` hydrates each query from IndexedDB.
5. Network attempts fail; React Query keeps the hydrated data.
6. `OfflineIndicator` shows "Offline — showing saved data from HH:MM".

### Blocked / unreachable network (`navigator.onLine` still true)

The same path, except the settings fetch is attempted and may take up to the
WebView timeout. The snapshot is already on screen, so the delay does not blank
the app; the banner appears when the fetch eventually marks the app offline.

### Reconnect

The `online` event triggers a silent settings refresh. React Query revalidates
active queries and the caches are rewritten.

### First launch with no session

Not supported offline. The login screen needs Supabase Auth. A local PIN /
offline credential is a later decision.

## Cache keys

| Store | Key | Value |
|---|---|---|
| localStorage | `sb-<project-ref>-auth-token` | session (existing behaviour) |
| localStorage | `keel:offline:shop:<authUserId>` | `shop_id` |
| IndexedDB `keel-offline` → `cache` | `keel:offline:settings:<shopId>` | `{ settings, savedAt }` |
| IndexedDB `keel-offline` → `cache` | `rq:<JSON.stringify(queryKey)>` | `{ data, savedAt }` |

Examples of query keys:

- `rq:["dashboardSummary"]`
- `rq:["inventory","products",0,50,""]`
- `rq:["inventory","catalogue"]`
- `rq:["inventory","attributes",["<product-id>",…]]`
- `rq:["sales","list",0,50,""]`

Search terms and page numbers are part of the key, so only pages the owner has
actually visited are cached. That is intentional: a search for a term never used
offline shows nothing rather than a misleading result.

## Behaviour matrix

| Surface | Online | Offline |
|---|---|---|
| Session | Normal | Stays signed in |
| Overview | Live `get_dashboard_summary` | Last cached summary |
| Inventory list | Live paginated products | Last cached page |
| Inventory catalogue/attributes | Live | Last cached |
| Sales history | Live paginated sales | Last cached page |
| Settings | Live + snapshot save | Snapshot |
| Finance / Customers / Orders / Services / Reports / Invoices | Live | Not cached yet — page renders, data queries fail/empty |
| Inbox / Assistant / Marketing / Storefront | Live | Online-only |
| Writes (sale, expense, stock, settings) | Live | Not queued; the action fails |

## Verification

### Manual

1. Sign in online and visit Overview, Inventory and Sales.
2. Close the app.
3. Disconnect the network (or turn off Wi-Fi).
4. Reopen. The app should show the same shop, settings and pages, with the
   offline pill.

### Automated (used during the build)

CDP against the dev app:

1. Visit Inventory, Sales and Overview online to fill the cache.
2. Block `*supabase.co*` only (the local app server stays reachable) and reload.
   This empties React Query's memory, so anything rendered must come from
   IndexedDB.
3. Confirm Inventory shows the products and the header shows the real shop name.
4. Emulate `offline: true` and confirm the banner appears without a reload.
5. Unblock + go online and confirm the banner clears and data revalidates.

Observed: **5 products**, **8 sales**, `OLFATTA / Laundry Pro Live`, banner
"Offline — showing saved data from 14:35".

### Tests / lint

- Targeted: 42 tests across `Inventory`, `Sales`, `useQueries`, `shop`,
  `AuthContext`, `SaleStatusBadge` — all pass.
- ESLint on every touched file: 0 errors (3 warnings: one pre-existing
  fast-refresh warning and two exhaustive-deps warnings on the new settings
  effects).
- The full Vitest suite exceeded 10 minutes on this machine and was stopped; the
  affected subset is green.

## Deferred: offline writes

The next phase needs more than a queue. Before writing it:

1. **A durable outbox** in IndexedDB (not localStorage), with client-generated
   UUIDs and no 24-hour deletion.
2. **An idempotent server operation** for a sale — one RPC that writes the sale,
   decrements stock and is safe to replay. Without it, a retry after a partial
   failure can create two sales, and an absolute `newStock` can overwrite
   another device's sale.
3. **Delta stock updates**, not absolute values.
4. **Optimistic UI** so the till reflects an offline sale immediately, marked
   pending until acknowledged.
5. **A database migration**, which was explicitly deferred and needs approval.

Do not start with the queue alone. A queue without idempotency is a duplicate
sale waiting for a bad connection.

## Design rules learned

- **A failed read must not be cached as an empty result.** That is why the page
  hooks now log and throw instead of resolving `[]`.
- **Settings/identity before network.** A request that cannot complete can hang
  for the whole WebView timeout; the snapshot must already be applied.
- **`maybeSingle()` returning `null` is not "no row".** It is also what a failed
  request returns. Treating the two as the same made an offline launch try to
  create a second shop.
- **Only a real 401 clears the session.** A network failure is not a logout.
- **Set `updatedAt` when hydrating.** Otherwise React Query treats the snapshot
  as fresh and the page never revalidates.
