# Offline sales — first slice

Decisions already taken:

- `log_sale` RPC: **approved**.
- Scope: **sales only**. Expenses and stock follow.
- Pending sales: **merged into the Sales list with a badge**.
- Oversell: **allow negative stock and warn**, never reject a real sale.

## `log_sale` contract

`public.log_sale(p_shop_id uuid, p_batch_id uuid, p_items jsonb, p_method text,
p_mpesa_code text, p_created_by uuid, p_created_at timestamptz) returns jsonb`

- **Tenant boundary.** `SECURITY DEFINER` bypasses RLS, so the function resolves
  the caller with `auth.uid()` → `users`. It rejects a `p_shop_id` that is not
  the caller's shop. The client shop id is accepted only so the existing call
  shape stays familiar; it is not trusted.
- **Idempotency.** An advisory lock on `batch_id`, then a check for existing
  `sales` rows with `(shop_id, batch_id)`. A replay returns
  `{ ok: true, already_applied: true }` without inserting or decrementing again.
- **Items.** One `sales` row per item, with a snapshot of the product name and
  the amount the client charged. Product ids are validated against the shop.
- **Stock.** `stock = stock - quantity`, never an absolute value. Negative stock
  is allowed. The function returns the resulting stock and a `low_stock` array.
- **Attribution.** `created_by` is the seller captured at tap time, accepted only
  when that user belongs to the shop; otherwise the caller. This matters when an
  offline sale is synced by a different signed-in user.
- **Time.** `p_created_at` carries the time of the sale, not the sync time, so
  the day's totals land in the right day.
- **Return.**
  `{ ok, already_applied, batch_id, sales: [...], low_stock: [{ product_id, product_name, stock }] }`.
- **Grants.** `revoke ... from public, anon`; `grant ... to authenticated` (and
  `service_role` for future bot/assistant use).

## Client outbox

A new IndexedDB store (`outbox`) alongside the read cache. One item per cart,
not per line:

```js
{
  id: `sale:${batchId}`,
  type: "sale",
  shopId,
  batchId,
  items: [{ product_id, product_name, quantity, amount }],
  method,
  mpesaCode,
  createdBy,
  createdAt,
  status,          // pending | needs_auth | failed
  attempts,
  lastError,
  enqueuedAt,
}
```

- `commitProductSales()` tries the RPC when online; on a network failure it
  enqueues. A permanent server error (product not found, not authenticated) is
  surfaced to the caller, not queued as if it worked.
- `processSalesOutbox()` runs on app start and on `online`. A replay is safe
  because of `batch_id`.
- A real auth failure pauses the item as `needs_auth` and stops the loop.
- Legacy `logSale` items in the old localStorage queue are grouped by
  `batch_id` and adopted into the new outbox on start.

## Pending rows

- `usePendingSales()` reads the outbox and refreshes on outbox events.
- The Sales page prepends pending rows on page 0 with no search, groups them by
  `batch_id` exactly like server rows, and shows a **Pending sync** badge.
- The receipt is already local; it gets a pending note when the sale was queued.
- Inventory's cached stock is decremented immediately so the till's stock guard
  stays honest. The server response is authoritative after sync.
- Dashboard and Reports remain server-only for this slice and must not silently
  pretend pending sales are included. A "N pending" note is the minimum.

## Files

**Keel (source)**
- `supabase/migrations/20261102_add_log_sale_rpc.sql`
- `src/lib/offline/db.js` (outbox store, DB version 2)
- `src/lib/offline/salesOutbox.js` (new)
- `src/lib/offline/inventoryCache.js` (new)
- `src/lib/saleWriter.js` (commitProductSales)
- `src/components/LogSaleModal.jsx`, `SalesTill.jsx`
- `src/hooks/usePendingSales.js` (new)
- `src/pages/Sales.jsx`, `SaleStatusBadge.jsx`, `ReceiptModal.jsx`
- `src/lib/writeQueue.js` (adopt legacy sales)
- `src/main.jsx` (start the outbox)

**Desktop**
- No shell change; `pnpm sync` + rebuild picks it up.

## Built (2 Nov)

- `supabase/migrations/20261102_add_log_sale_rpc.sql` applied; grants are
  authenticated-only (`anon` and `service_role` both false).
- `log_sale` tested twice in a rollback transaction against real data: one sale
  row, one stock decrement, and `already_applied` on replay. A partially applied
  legacy batch raises instead of being treated as complete.
- `commitProductSales` calls the RPC online, queues on a network failure, and
  throws on a permanent rejection.
- Durable IndexedDB `outbox` (DB version 2), legacy `logSale` adoption, retry on
  reconnect, `needs_auth` pause, `failed` + manual retry.
- Sales page merges pending rows by `batch_id`, with Pending sync / Sync failed /
  Sign in to sync badges and a "N pending sync" pill.
- Receipts print **PENDING SYNC**; the inventory cache is decremented
  optimistically.
- Live desktop check: with Supabase blocked, a real sale was logged and showed
  the pending row, the receipt note, and the outbox item; the outbox was then
  cleared **before** reconnecting, so no test sale was written to the live shop.
- 26 focused tests pass (saleWriter 9, salesOutbox 5, Sales 6, Inventory 6),
  lint 0.

**Not yet done:** a full sync against a throwaway live shop. The RPC is
SQL-tested and the flush path is unit-tested, but the two have not been run
together against a disposable tenant. Dashboard and Reports still exclude
pending sales and need an overlay or an explicit notice.

## Verification

1. SQL: call `log_sale` twice with the same `batch_id` inside a rollback
   transaction. Assert one set of sale rows, one stock decrement, and
   `already_applied` on the second call.
2. Online web: log a sale; the row appears and stock drops.
3. Offline desktop: log a sale with Supabase blocked; the receipt and a
   **Pending sync** row appear. Reconnect; the row is replaced by the server row,
   stock matches, and the outbox is empty.
4. Failed sale: a product that no longer belongs to the shop is rejected and
   surfaced, not silently queued.
5. Lint + focused tests; rebuild the desktop installer.
