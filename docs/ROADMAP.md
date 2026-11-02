# Roadmap and open decisions

## Done

- Tauri v2 shell, local `dist`, sync before every build, MSI + NSIS.
- Offline reads: session survives a network refresh failure, cached `shop_id`,
  settings snapshot, cached Overview/Inventory/Sales, offline pill.
- Offline **sales**: atomic `log_sale` RPC, IndexedDB outbox, replay on reconnect,
  pending rows with badges, receipt note, optimistic stock, legacy queue
  adoption.
- Write-path study of all 119 client write call sites and the relevant DB
  objects.

## Next, in order

### 1. Full E2E sync against a throwaway shop

The RPC is SQL-tested and the flush is unit-tested, but they have not run
together against a disposable tenant.

- Create the test auth user through the real signup API (not a hand-inserted
  `auth.users` row).
- Let the app create the shop; add one product; log a sale offline; reconnect;
  assert the server row, stock, and empty outbox.
- Delete the shop (cascade) and the auth user.
- Do **not** use a live shop for this.

### 2. Dashboard/Reports pending visibility

Dashboard and Reports read server-side aggregates and currently exclude pending
sales. Options:

- Add a client overlay for today's revenue/items/payment split/recent sales, and
  label "includes N pending".
- For Reports, exclude pending with a visible "N pending not included" note
  (profit margins are server-computed and cannot see them).

Do not silently show a total that omits a sale the owner just made.

### 3. Expenses offline

Single table, client-supplied uuid, no dependent rows.

- Queue `insert` with `on conflict (id) do nothing`.
- Updates/deletes are last-write-wins; no `updated_at` exists.
- No DB change.

### 4. Stock adjustments offline

- Add `adjust_stock(p_movement_id, p_product_id, p_change, p_reason)`.
- Idempotent by movement id, delta stock, movement + product in one transaction.
- Convert absolute stock edits (inventory sheet / product edit) into deltas from
  the last known value.
- Current `StockAdjustModal`/`InventorySheet`/`importProducts` send absolute
  `newStock`; do not queue that shape as-is.

### 5. Products offline

- Add/update/delete with client ids; delete is idempotent.
- `products` has no `updated_at`, so edits are last-write-wins. Add a version /
  `updated_at` only if real conflicts appear.
- Keep stock out of the general product update; use the stock slice.
- Attributes are a second table; a product RPC may be cleaner than two queued
  writes.

### 6. Orders offline

- `create_order` RPC: derive shop from auth, upsert the customer by
  `(shop_id, phone)`, insert the order with a client id (the trigger allocates
  `order_number`), insert items, all in one transaction.
- `update_order` / `set_order_status` RPCs for atomic item replacement and
  status-history append.
- Current `createOrder` is a non-transactional select/insert/insert; it must not
  be queued as-is.

### 7. Invoices offline

- `create_invoice_v2`: accept a client id, derive the shop from auth, allocate
  `number_seq` under an advisory lock, be idempotent.
- `record_invoice_payment_v2`: accept a client payment id, row-lock the invoice,
  insert the payment + sales mirror + `amount_paid` in one transaction.
- **Fix the existing security gap at the same time:** `create_invoice` trusts
  `p_payload->>'shop_id'`; `record_invoice_payment` selects by id without a shop
  check. Both are `SECURITY DEFINER` and bypass RLS.

### 8. Customers / services offline

- Customer edit/delete is a single table; creation belongs inside the order /
  invoice RPC (unique `(shop_id, phone)`).
- Services: unique `(shop_id, category, name)`; insert/update/soft delete can be
  queued app-side.

### 9. Optional: settings / config / social

Low-frequency, high-conflict, often depends on an online service. Keep
online-only unless there is a concrete need.

## Open decisions

1. **Report honesty:** exclude pending with a notice, or approximate profit with
   pending revenue? Recommended: exclude with a notice; margins are
   server-computed.
2. **Product edit conflicts:** accept last-write-wins, or add `updated_at` /
   version columns?
3. **Oversell:** already chosen — allow negative and warn. Revisit only if the
   shop wants a hard floor.
4. **First login offline:** a local PIN? `users.pin_salt` / `pin_set_at` already
   exist from the team feature, but a PIN is a security decision, not a cache.
5. **Cache retention:** currently unbounded per query key. Add a size/age cap
   before the cache grows with every search.
6. **Tauri updater:** not configured. Shipping a new build currently needs a
   manual install.
7. **Pending pagination:** the Sales count includes pending batches; at exact
   page-size multiples it can add one empty page. Separate `displayTotal` from
   the server `total` when this is touched.
8. **Outbox on web:** the sales outbox is not gated to desktop, so a web sale on
   a network failure is queued too. Decide whether to keep this or gate it to
   Tauri.

## Known risks

- A permanent rejection leaves a pending/failed row until someone retries; there
  is no background dead-letter UI beyond the Sales page.
- A sale logged offline for a product deleted on another device fails at sync;
  the money is not lost (the receipt exists) but the ledger row needs attention.
- The full Vitest suite takes >10 minutes on this machine; CI should not assume a
  quick run.
- `log_sale` is `SECURITY DEFINER`; any future edit must keep the auth-derived
  shop check and the authenticated-only grant.
