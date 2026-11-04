# Runbook

## 1. Apply the `log_sale` migration

Run from the **keel** repo (the Supabase project is linked there):

```bash
cd ../keel
supabase db query --file supabase/migrations/20261102_add_log_sale_rpc.sql --linked
```

The migration is additive: no table or column changes. It creates/replaces
`public.log_sale` and sets grants.

Verify the grants:

```sql
select jsonb_build_object(
  'authenticated', has_function_privilege('authenticated',
    'public.log_sale(uuid,uuid,jsonb,text,text,uuid,timestamptz)', 'EXECUTE'),
  'anon', has_function_privilege('anon',
    'public.log_sale(uuid,uuid,jsonb,text,text,uuid,timestamptz)', 'EXECUTE'),
  'service_role', has_function_privilege('service_role',
    'public.log_sale(uuid,uuid,jsonb,text,text,uuid,timestamptz)', 'EXECUTE')
) as grants;
```

Expected: `authenticated: true`, `anon: false`, `service_role: false`.

## 2. Verify the RPC without leaving data behind

`docs/sql/verify-log-sale.sql` runs the whole test in a transaction and rolls it
back. It picks a real owner/shop/product with stock ≥ 2, simulates that user's
JWT, calls `log_sale` twice with the same batch id, asserts the first write and
the replay, then rolls back.

```bash
cd ../keel
supabase db query --file ../keel-desktop/docs/sql/verify-log-sale.sql --linked --output-format json
```

Expected:

```json
{ "result": "log_sale test passed" }
```

If it fails, it raises before the `select`, and the CLI reports the assertion
message.

## 3. Test offline sales in the app

1. `pnpm sync` in `keel-desktop` (builds `../keel` and refreshes `./dist`).
2. `pnpm tauri dev`; sign in online.
3. Visit **Sales**, **Inventory** and **Overview** once so their read caches
   exist.
4. Drop the network:
   - Real test: disable Wi-Fi / unplug the network.
   - Controlled test: use CDP `Network.emulateNetworkConditions` with
     `offline: true` (see below).
5. Sales → **Log sale** → add a product → **Log sale**.
6. Expected: receipt opens with **PENDING SYNC**; the Sales page shows
   **1 pending sync** and the row with a **Pending sync** badge.
7. Reconnect. The outbox processes on the `online` event or the next app start.
8. Expected: the pending row is replaced by the server row, the badge disappears,
   and the stock matches.

Check the database after sync:

```sql
select id, product_name, amount, quantity, method, shop_id, batch_id, created_at
from public.sales
where batch_id = '<the batch id>';
```

## 4. Debug with CDP (local only)

Tauri dev does not expose a debug port by default. To inspect the WebView:

1. Temporarily add this to the window object in
   `src-tauri/tauri.conf.json`:

   ```json
   "additionalBrowserArgs": "--remote-debugging-port=9222 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
   ```

2. `pnpm tauri dev`.
3. Connect to `http://127.0.0.1:9222/json` (WebView2 may bind IPv6 only; try
   `http://[::1]:9222/json`).
4. **Remove the argument before any release build.** It ships a debugging
   surface otherwise.

### Inspect IndexedDB

The `keel-offline` database has two stores:

- `cache` — read snapshots (`rq:<queryKey>`, settings).
- `outbox` — pending sales.

In the DevTools console:

```js
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open("keel-offline");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const db = await open();
const tx = db.transaction("outbox", "readonly");
const rows = await new Promise((res, rej) => {
  const q = tx.objectStore("outbox").getAll();
  q.onsuccess = () => res(q.result);
  q.onerror = () => rej(q.error);
});
console.table(rows);
```

### Discard a test outbox item

Only do this for a test sale. Clearing the store throws the sale away; it does
**not** refund anything because no payment was captured.

```js
const tx = db.transaction("outbox", "readwrite");
tx.objectStore("outbox").clear();
await new Promise((res) => { tx.oncomplete = res; });
```

For a real failed sale, use the **Retry** button on the Sales page instead.

## 5. Rebuild and ship

```bash
pnpm sync
pnpm build
```

Artifacts:

```
src-tauri/target/release/keel-desktop.exe
src-tauri/target/release/bundle/msi/Keel_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Keel_0.1.0_x64-setup.exe
```

`pnpm build` runs `sync` first, so the installer always contains the current
`../keel` build. The first release build is slow (Rust/LTO); later builds are
incremental.

### Ship via CI

CI is the supported path — it always records which Keel commit is inside the
installer and needs no local Rust toolchain:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The `Release` workflow stamps `0.2.0` into the Tauri manifests, builds against
`FrameStudio-cloud/keel@main`, and publishes the MSI + NSIS setup to a GitHub
release. To build a different Keel ref without publishing, run the workflow
manually from the Actions tab and set `keel_ref`.

Before the first CI run, add the `KEEL_REPO_TOKEN`, `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` secrets — see [SETUP](SETUP.md#ci-releases).

The release notes and the attached `BUILD-INFO.txt` carry the Keel short SHA.
Use that in incident notes: it is the only reliable way to know what UI a user
is running.

The same run publishes `latest.json`, which installed copies poll on launch. So
a release is also an update — with three rules:

- delete the release later and the updater 404s for everyone still on it;
- a prerelease or draft is invisible to `releases/latest`;
- the tag version must be higher than the one users have, or the update is
  ignored.

If an update fails on a user's machine, the app shows the error and keeps
running the old version; it never half-installs. Ask them for that message
before doing anything else.

## 6. Rollback policy

`log_sale` is additive, but the client depends on it. If you need to roll back:

1. Revert `saleWriter.js`/the outbox to the old `writeQueue` path **first**.
2. Only then drop the function.

Dropping the function while the current client is deployed makes every new sale
fail with "function not found". The table and its data are untouched either way.

## 7. Troubleshooting

| Symptom | Cause / action |
|---|---|
| `Not authenticated` from `log_sale` | Session missing/expired; sign in. The outbox marks the item `needs_auth` and shows "Sign in to sync". |
| `Not allowed for this shop` | Cached `shop_id` is stale. Sign out/in, or clear `keel:offline:shop:<authUserId>`. The item is `failed`; retry after fixing. |
| `Batch … is partially applied` | A legacy partial batch (old queue wrote some lines). Needs manual reconciliation; the item shows **Sync failed**. |
| Pending row never clears | Check `navigator.onLine`, the session, and the outbox status. Use Retry for `failed`/`needs_auth`; a `pending` item retries on `online` and every 30s while online. |
| `function public.log_sale(...) does not exist` | The migration was not applied to the Supabase project the build points at. Apply it and redeploy. |
| `permission denied for function log_sale` | Grants were not applied or were overwritten. Re-run the revoke/grant block and check `has_function_privilege`. |
| Sale appears twice | `batch_id` was not reused. The client generates it per cart; a manual replay with a new batch id is a new sale. |
| Stock is wrong after a replay | `log_sale` is idempotent per `batch_id`; check the batch id and whether the first call committed. |
| Dev app shows stale UI | `pnpm sync`, then reload/restart dev. Tauri does not watch `../keel`. |
| Release app has no session/cache | Dev and release use different origins; sign in online once in the release profile. |
