# Write paths — study before offline writes

> **Status:** this was the read-only study. The **sales** slice has since been
> built — see [OFFLINE-SALES-PLAN](OFFLINE-SALES-PLAN.md). Expenses, stock,
> orders and invoices remain on their current paths; the order is in
> [ROADMAP](ROADMAP.md). The analysis below is unchanged.

Read-only analysis of Keel's write surfaces, the existing queue, and the database
rules that decide what can safely be queued.

## Executive summary

- The existing `writeQueue` is **not an offline engine**. It is a localStorage
  retry list with a 5-attempt cap and no idempotency. It was built to smooth
  online writes, not to survive a day without internet.
- **Sales are the valuable and tractable first slice.** The cart already has a
  client-generated `batch_id`, the receipt is produced locally, and the rows are
  append-only. What is missing is an atomic, idempotent server operation and a
  delta stock update.
- **Stock is the dangerous part.** The queue sends absolute `stock: newStock`.
  A second device selling the same item, or a replay after a partial failure,
  can silently overwrite stock. Offline writes must use deltas.
- **Orders and invoices need server RPCs.** Both are multi-table and both let
  the server allocate a number (`order_number`, `number_seq`). Client-side
  replay can duplicate them. The current `create_invoice` is also not idempotent
  and does not verify shop ownership.
- **Most configuration does not belong in v1.** Settings, banners, page content,
  chat config, social posts and integrations are low-frequency, high-conflict
  and often depend on an online service. Keep them online-only for now.
- **A database change is required** for a correct first slice: at minimum one
  `log_sale` RPC. The decision to allow that was deferred until this study; it is
  now the blocking decision.

## Current write architecture

```
UI component / page
  ├── writeQueue.enqueueWrite()  ──► localStorage queue ──► executeWrite()
  │        (products, sales, stock, invoices)                  └── supabase.from/rpc
  ├── direct supabase.from(...)  ──► PostgREST (expenses, customers, orders,
  │                                             invoices, settings, posts...)
  └── supabase.rpc(...)          ──► SECURITY DEFINER functions
                                                (create_invoice,
                                                 record_invoice_payment,
                                                 record_paid_collection...)
```

Two parallel write styles exist:

1. **Queued** — `writeQueue.js` handles `logSale`, `addProduct`, `updateProduct`,
   `deleteProduct`, `adjustStock`, and two unused invoice types.
2. **Direct** — everything else writes immediately and reports the error in the
   component.

The read cache added in v1 is independent of both. It only stores successful
reads; it does not know about pending writes.

## Write surface inventory

| Surface | Where | Tables / RPC | Path today | Offline verdict |
|---|---|---|---|---|
| Log sale | `saleWriter.js`, `LogSaleModal`, `SalesTill` | `sales` insert + `products.stock` update | queue | **Needs `log_sale` RPC** |
| Stock adjust | `StockAdjustModal`, `InventorySheet`, `importProducts` | `stock_movements` insert + `products.stock` update | queue | **Needs `adjust_stock` RPC** |
| Add product | `AddProductModal`, `PasteImportModal`, `importProducts` | `products` + `product_attribute_values` | queue | App-side queue possible (client id) |
| Edit product | `EditProductModal`, `InventorySheet` | `products` (+ attributes) | queue | App-side, but stock must be a delta |
| Delete product | `InventorySheet`, `writeQueue` | `catalogue` delete, `products` delete | queue | App-side (idempotent) |
| Expenses | `Finance.jsx` | `expenses` insert/update/delete | direct | App-side queue (client id) |
| M-Pesa reconciliation | `Finance.jsx` | `mpesa_transactions` insert + `sales` update | direct | Online-only v1 (manual import) |
| Customer edit/delete | `Customers.jsx`, `serviceData.js` | `customers` update/delete | direct | App-side queue (last-write-wins) |
| Customer create | inside `createOrder`, `create_invoice` | `customers` insert/find by phone | direct/RPC | Belongs inside order/invoice RPC |
| Create order | `serviceData.js`, `Orders.jsx` | `customers`, `service_orders`, `service_order_items` | direct, multi-step | **Needs `create_order` RPC** |
| Update order / status | `serviceData.js`, `Orders.jsx` | `service_orders`, `service_order_items` | direct, multi-step | **Needs `update_order` / status RPC** |
| Services | `serviceData.js`, `Services.jsx` | `services` insert/update/soft delete | direct | App-side queue (unique key) |
| Create invoice | `invoices.js`, `InvoiceModal` | `create_invoice` RPC | direct/RPC | **Needs an idempotent RPC** |
| Edit invoice / share link / mark sent | `invoices.js` | `invoices` update/delete | direct | App-side queue (last-write-wins) |
| Record invoice payment | `invoices.js`, `RecordPaymentModal` | `record_invoice_payment` RPC | direct/RPC | **Needs an idempotent RPC** |
| Catalogue publish/unpublish | `Inventory.jsx` | `catalogue` + `catalogue_attribute_values` | direct | App-side queue (low priority) |
| Store settings / shop | `Settings.jsx`, `StoreTab`, `ProfileAboutTab` | `store_settings`, `shops` | direct | Online-only v1 |
| Chat config / feature toggles | `PreferencesTab`, `FeatureToggles`, `WhatsAppBotCard` | `chat_config` | direct | Online-only v1 |
| Banners / page content | `ContentTab`, `pageContent.js` | `banners`, `page_content` | direct | Online-only v1 |
| Posts / social | `Queue.jsx`, `PostComposer`, `PostCard` | `posts`, `content_templates` | direct | Online-only v1 (publishing is external) |
| Notification state | `useNotifications.js` | `notification_state` upsert | direct | Idempotent; queue optional |
| Onboarding progress | `onboarding.js` | `merge_onboarding_progress` RPC | direct | Idempotent; queue optional |
| Announcement dismiss | `AnnouncementBanner.jsx` | `announcement_dismissals` insert | direct | Idempotent-ish; queue optional |
| Integration goals | `useIntegrationGoals.js` | `integration_goals` upsert | direct | Online-only |
| Google Calendar disconnect | `googleCalendar.js` | `google_integrations` delete | direct | Online-only |
| Auth / signup | `AuthContext.jsx` | `shops`, `users`, `store_settings`, `chat_config` | direct | **Must stay online** |
| Payments / refunds / collections | edge functions | `collections`, `refunds`, `platform_fees` | edge | **Must stay online** |
| WhatsApp / Telegram | edge functions | bot tables | edge | **Must stay online** |
| Storefront deploy | `Storefront.jsx` | provisioner | edge | **Must stay online** |
| Email / AI / manifest | edge functions | `email_logs`, etc. | edge | **Must stay online** |

## The existing queue, in detail

`src/lib/writeQueue.js`:

- Stored in **localStorage** (`keel_write_queue`), not IndexedDB.
- One item per operation, with `status` pending/retrying/failed/completed.
- `MAX_RETRIES = 5`, exponential backoff capped at 16s. After roughly 31s of
  failures the item becomes `failed` and stops.
- It processes on enqueue and once on app start (`main.jsx` `QueueInit`).
  **There is no `online` listener and no periodic retry**, so a failed item
  stays failed until the user presses retry in `QueueStatus`.
- Completed items are deleted after 24h. Failed items are kept indefinitely.
- **No idempotency key.** A retry re-runs the same insert.
- `logSale` does two writes: insert `sales`, then update `products.stock` to an
  **absolute** `newStock`. A partial failure (sale inserted, stock update failed)
  is retried as a fresh insert → duplicate sale. Two devices also overwrite each
  other's stock.
- `adjustStock` has the same absolute-stock and partial-failure shape.
- `deleteProduct` deletes the catalogue row first, then the product. A failure
  between them leaves the catalogue gone and the product present.
- `addProduct` inserts the product, then the attribute values. A failure leaves
  a product without its attributes.
- The `createInvoice` and `recordInvoicePayment` cases are **dead code**: nothing
  enqueues those types. Invoices are written directly through `invoices.js`.

`QueueStatus.jsx` shows the queue in Inventory and Sales, with retry controls.
There is no queue test file.

## Database facts that decide the design

Inspected live (`pg_constraint`, `pg_indexes`, `pg_trigger`, `pg_proc`, `pg_policies`).

### Client IDs are already possible

Every writable table uses `id uuid default gen_random_uuid()`. A client may supply
its own UUID; the database accepts it. That makes `on conflict (id) do nothing`
and `upsert` viable without adding a new ID column.

### Sales

- `sales.id` is the primary key, default `gen_random_uuid()`.
- `batch_id uuid` exists but is **only indexed**, not unique:
  `CREATE INDEX sales_batch_id_idx ON sales (shop_id, batch_id)`.
- `created_by` references `users(id)`; the trigger `set_created_by` fills it from
  `auth.uid()` when null.
- `products.stock` is `integer not null default 0`, **no check constraint** and
  no `updated_at`. Negative stock is accepted by the database.
- There is **no** `log_sale` function today.

### Stock movements

- `stock_movements.id` PK, `change integer` (signed), no FK to `products`.
- `created_by` trigger.
- No `updated_at`.

### Expenses

- `expenses.id` PK, no `updated_at`, `created_by` trigger.
- Single-table insert/update/delete; no dependent rows.

### Customers

- `id` PK.
- **Unique partial index `(shop_id, phone) where phone is not null`** — this is
  the natural idempotency key for customer creation.
- No `updated_at`; edits are last-write-wins.

### Service orders

- `id` PK; `order_number integer not null`; `unique (shop_id, order_number)`.
- `assign_service_order_number()` is a `BEFORE INSERT` trigger that takes a
  per-shop advisory lock and allocates `max + 1`. The client cannot reliably pick
  the number.
- `updated_at` exists.
- `service_order_items` has `order_id` FK with `ON DELETE CASCADE`, no FK to
  `services` (name/price are copied).

### Invoices and payments

- `invoices.id` PK; `number_seq integer not null`; `unique (shop_id, number_seq)`.
- `create_invoice(p_payload)` is `SECURITY DEFINER`. It reads `shop_id` **from the
  payload**, allocates `max(number_seq) + 1` **without an advisory lock** (the
  function comment in `assign_service_order_number` explicitly says this is not
  atomic), and inserts a new invoice every call. **It is not idempotent.** It also
  creates a customer by phone if none exists (select-then-insert against the
  unique index).
- `record_invoice_payment(...)` row-locks the invoice, inserts an
  `invoice_payments` row, mirrors a `sales` row, and adds `amount_paid`. It has
  **no idempotency key**: replaying it records the payment twice.
- Neither function verifies that the caller belongs to the invoice's shop. Both
  are `SECURITY DEFINER`, so RLS does not protect them. `create_invoice` trusts
  `p_shop_id`; `record_invoice_payment` selects the invoice by id only. This is a
  pre-existing cross-tenant risk that a new sync RPC must not repeat.
- `record_paid_collection(p_reference, ...)` is the good pattern: it row-locks
  the collection, returns `already_processed: true` if `status = 'paid'`, and
  only then mirrors the sale. Idempotency is by `reference` (unique).

### RLS

Every table has a tenant-scoped policy of the shape
`shop_id = (select users.shop_id from users where users.auth_user_id = auth.uid())`.
The queue uses the signed-in user's JWT, so RLS applies to normal inserts. It
does **not** apply inside the `SECURITY DEFINER` RPCs above.

## Classification

### A. Safe to queue app-side (single table, client id, no server number)

- Expenses (insert; update/delete last-write-wins).
- Add/update/delete product (with stock separated — see below).
- Customer edit/delete.
- Service create/update/soft delete.
- Catalogue publish/unpublish.
- Notification state (already an idempotent upsert).
- Onboarding progress (RPC merge, same call is safe to repeat).
- Announcement dismissals.

These still need a durable outbox, retry-on-reconnect and optimistic reads, but
they do not need a new database function.

### B. Needs a server RPC (multi-table, server number, or money)

- **Sale** — `sales` insert + `products.stock` delta, atomically.
- **Stock adjustment** — `stock_movements` insert + `products.stock` delta,
  atomically.
- **Create order** — customer find/create, `service_orders` insert (trigger
  allocates `order_number`), `service_order_items` insert.
- **Update order / status** — order + items, or an atomic status-history append.
- **Create invoice** — customer find/create, atomic `number_seq` allocation,
  idempotent by client id, shop derived from auth.
- **Record invoice payment** — payment row + sales mirror + `amount_paid`,
  idempotent by client payment id.

### C. Must stay online

- Auth, signup, password reset.
- Paystack payments, refunds, collections, STK push.
- WhatsApp/Telegram, Google Calendar, storefront deploy, email, assistant/AI,
  manifest fetch.
- Social publishing (the row can be queued, but "publish" is external).
- M-Pesa CSV reconciliation (manual, online task).

## Recommended architecture

### 1. Durable outbox

Move the queue to IndexedDB (the same `keel-offline` database, a new `outbox`
store). Each item carries:

```js
{
  id,                  // outbox item id
  type,                // "sale" | "expense" | "stock" | "order" | "invoice" | ...
  shopId,
  payload,
  idempotencyKey,      // batch_id / client row id
  status,              // pending | syncing | failed | needs_auth
  attempts,
  lastError,
  createdAt,
  nextAttemptAt,
  dependsOn,            // optional parent outbox id
}
```

Retry on: app start, `online` event, window focus, and a timer while online.
Never delete failed items; expose them in a queue drawer with retry/discard.
Pause on a real auth failure (`needs_auth`) instead of retrying forever.

### 2. Idempotent server operations

- `log_sale(p_batch_id, p_items, p_method, p_mpesa_code)`:
  advisory lock on `batch_id`; if the batch is already present, return
  `already_applied`; insert one `sales` row per item with client ids; apply
  `stock = stock - qty`; return the rows.
- `adjust_stock(p_movement_id, p_product_id, p_change, p_reason)`:
  idempotent by movement id; insert the movement and apply the delta.
- `create_order(p_client_id, p_payload)`:
  customer upsert by `(shop_id, phone)`; insert the order with the client id
  (trigger allocates `order_number`); insert items; all in one transaction.
- `update_order` / `set_order_status`:
  update order + items atomically; append status history inside the function.
- `create_invoice_v2(p_client_id, p_payload)`:
  shop from `auth.uid()`, not the payload; advisory lock for `number_seq`;
  idempotent by client id; customer find/create.
- `record_invoice_payment_v2(p_payment_id, p_invoice_id, ...)`:
  idempotent by payment id; row-lock invoice; insert payment; mirror sale;
  update `amount_paid`.

### 3. Pending reads

Keep the server snapshot and pending local rows separate. Query hooks merge
pending sales/expenses/products into the cached result and mark them "Pending
sync". At minimum, a completed offline sale must appear in the Sales list and in
today's totals; otherwise the receipt is the only evidence it exists.

### 4. Conflict policy

- **Append-only** (sales, expenses, stock movements, payments): safe with
  idempotency keys.
- **Stock**: always delta. Never send absolute stock from a product edit; convert
  a stock edit into a delta from the last known value. Decide whether negative
  stock is allowed (the DB allows it) and surface an oversell warning.
- **Product/customer/service edits**: last-write-wins for v1. Add `updated_at` /
  version only if conflicts become real.
- **Order status**: last-write-wins; append history with a client timestamp.
- **Settings/config**: last-write-wins; keep online-only for v1.

### 5. Auth and tenant safety

The outbox uses the same Supabase client. When the token is expired at sync
time, `getAccessToken()` refreshes. A real refresh rejection should pause the
outbox and prompt sign-in. New sync RPCs should derive `shop_id` from
`auth.uid()` and ignore a client-supplied shop id, which also fixes the existing
`create_invoice`/`record_invoice_payment` gap.

## Recommended first slice: sales only

1. Add `log_sale` (one RPC, transaction, advisory lock on `batch_id`, delta
   stock). No table changes required for this.
2. Replace the localStorage `logSale` path with a durable outbox item keyed by
   the existing `batch_id`.
3. Merge pending sales into the Sales list and dashboard totals with a "Pending
   sync" badge.
4. Retry on reconnect; show failed items in `QueueStatus`.
5. Leave expenses, products, orders and invoices on their current paths until
   the sale slice is proven offline.

Why sales first: highest business value, append-only, already has a client
`batch_id`, and the receipt is local. It is the smallest change that makes the
desktop app genuinely useful without internet.

## Why the sale path is legacy (from the docs)

There is no document that says "we chose not to add an RPC for sales." The
recorded history explains how it happened:

- `Keel Narrative/02 - Architecture Decisions.md` records the original decision
  as **"Bypass GoTrueClient, disable RLS, use app-level multi-tenancy"**, with
  "all queries already filter by `shop_id`". Sales were built in that era as a
  direct two-step write.
- `docs/keel-ecosystem/Supabase/RPC Functions.md` lists every RPC and why it
  exists (atomic invoice number, order + items in one transaction, row-locked
  payment). A normal sale is absent: it had no server-allocated number and was
  treated as a simple append.
- `docs/team-credit-plan.md` ground rule 3 records that "sales/stock/expenses
  flow through `writeQueue` (localStorage)", while ground rule 4 says all money
  writes should go through locked, idempotent `SECURITY DEFINER` RPCs. The plan
  then designed `add_credit_charge(...)` — atomic tab-sale lines, shared
  `batch_id`, relative stock decrement, `entry_key` idempotency — and a
  `logSaleCredit` queue case calling it. That was **credit sales only**; the
  normal sale path stayed on the queue. The credit book was later removed.
- `Keel Ecosystem/Features (Keel)/Keel Assistant.md` warns that
  **"only `log_sale` is atomic and idempotent"** (the assistant's
  `assistant_log_sale`), while the other assistant writes go directly through
  PostgREST. The author knew the normal path was not guarded.
- Offline was always planned as a queue, not an RPC sync
  (`Keel Architecture.md`: "Offline mode — Enhanced service worker + IndexedDB
  queue"; `Keel Narrative/04 - The Future.md`: "Service worker cache for POS
  when internet drops").

So `log_sale` is a **retrofit of a pattern that already exists** in the codebase
(`assistant_log_sale`, and the removed `add_credit_charge`), not a reversal of a
deliberate sales design.

## Decisions taken (2 Nov)

1. **Database change approved:** one `log_sale` RPC, no table or column change;
   idempotency by an advisory lock on `batch_id`.
2. **Scope:** sales only first. Expenses and stock adjustments follow.
3. **Pending visibility:** merged into the Sales list with a badge; the receipt
   prints "PENDING SYNC".
4. **Oversell:** allow negative stock and warn; never reject a real sale.
5. **Configuration:** settings, banners, page content, chat config, social and
   integrations stay online-only for this phase.
6. **Invoice security gap:** `create_invoice` / `record_invoice_payment` still
   trust the caller's ids. Treat fixing that as part of the invoice RPC work,
   not this slice.

## Appendix: exact write call sites

The scan of `src/**/*.{js,jsx}` found **119 write call sites**. The ones relevant
to this phase:

**Queued**
- `src/lib/writeQueue.js` — `addProduct`, `updateProduct`, `deleteProduct`,
  `adjustStock` (plus dead `createInvoice`, `recordInvoicePayment`). The old
  `logSale` case remains only as a fallback; pending items are adopted by the
  sales outbox on start.
- `src/lib/saleWriter.js` — `commitProductSales` calls `log_sale` once per cart
  online, or enqueues to the durable sales outbox offline.
- `src/components/AddProductModal.jsx`, `EditProductModal.jsx`,
  `StockAdjustModal.jsx`, `InventorySheet.jsx`, `PasteImportModal.jsx`,
  `src/lib/importProducts.js`, `src/pages/Inventory.jsx` — enqueue sites.

**Direct money paths**
- `src/pages/Finance.jsx` — expenses, M-Pesa reconciliation.
- `src/lib/serviceData.js` — customers, orders, items, services.
- `src/lib/invoices.js` — invoice create/update/delete, share link, payments.

**Configuration / low priority**
- `src/pages/Settings.jsx`, `src/components/website/*`,
  `src/lib/pageContent.js`, `src/pages/Queue.jsx`,
  `src/components/social/*`, `src/hooks/useNotifications.js`,
  `src/lib/onboarding.js`, `src/components/AnnouncementBanner.jsx`,
  `src/hooks/useIntegrationGoals.js`, `src/lib/googleCalendar.js`.

**Not client writes**
- `src/lib/seedData.js` (demo seeding), edge functions (payments, bots, email,
  calendar, storefront).
