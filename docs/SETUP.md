# Setup and build

## Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Node | 20.19+ or 22.12+ | Tested on 24.14 |
| pnpm | any recent | All Node packages use pnpm |
| Rust | stable | `cargo` + `rustc` on PATH |
| MSVC build tools | 2022 | Required by the Rust linker on Windows |
| WebView2 | bundled with Windows 10/11 | Tauri's runtime |
| Tauri CLI | `@tauri-apps/cli` devDependency | Use `pnpm tauri`; no global install |

The **Keel web repo** (`../keel`) must already have its own `node_modules` and a
`.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The desktop sync
runs `vite build` there; the Vite config throws if those are missing. The desktop
repo has no `.env` of its own.

## Install

```bash
cd keel-desktop
pnpm install
```

## Commands

```bash
pnpm sync        # build ../keel and refresh ./dist
pnpm tauri dev   # run the desktop app against ./dist
pnpm build       # sync + release build + MSI/NSIS
```

### `pnpm sync`

`scripts/sync-web.mjs`:

1. Verifies `../keel` and `../keel/node_modules` exist.
2. Runs `pnpm exec vite build` in `../keel`.
3. Deletes `./dist`.
4. Copies `../keel/dist` into `./dist`.
5. Renames any asset filename containing spaces and rewrites references in the
   copied JS/CSS/HTML. (Tauri's asset server returns `index.html` for a path with
   a space; the login hero image was broken without this.)
6. Fails loudly if the build fails or produces no `dist`.

It never modifies `../keel`'s source or its `dist`.

### `pnpm tauri dev`

- The first run compiles the Rust shell; later runs are fast.
- Tauri serves the local `dist` over `http://127.0.0.1:1430`.
- Changing `src-tauri/*` restarts the dev app. Changing `../keel` does **not**;
  run `pnpm sync` and reload.
- A fresh WebView profile shows the public landing page. The session is per
  origin/profile; sign in or use the normal profile.

### `pnpm build`

Runs `sync` first, so the installer can never contain an older web bundle.

Output:

```
src-tauri/target/release/keel-desktop.exe
src-tauri/target/release/bundle/msi/Keel_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Keel_0.1.0_x64-setup.exe
```

The first release build compiles ~349 Rust crates (15–20 minutes on this
machine). Later builds are incremental.

## Tauri configuration

`src-tauri/tauri.conf.json`:

| Key | Value | Why |
|---|---|---|
| `productName` | `Keel` | Window/installer name |
| `identifier` | `keel.framestudio.co.ke` | Bundle id; also selects the WebView data folder |
| `build.frontendDist` | `../dist` | Local bundle; no remote URL |
| window title | `Keel` | |
| window size | 1280 × 800 | |
| `withGlobalTauri` | `true` | The offline layer detects `window.__TAURI__` |

There is deliberately **no** `devUrl`, `beforeDevCommand` or `beforeBuildCommand`.
The sync is an explicit `pnpm` script so it can be run and inspected on its own.

## Adding or changing a page

Do it in `../keel` only. Then:

```bash
pnpm sync
pnpm tauri dev   # or pnpm build
```

Nothing in this repo needs to know about the page. The sync copies whatever the
web build produces.

## Environment

The desktop app inherits the Supabase configuration baked into the Keel build at
compile time (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). There is no runtime
environment file in the desktop repo.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Keel web app not found` | `../keel` is missing; the repo expects the sibling folder. |
| `Keel node_modules not found` | Run `pnpm install` in `../keel`. |
| `vite build failed` / missing env | Keel's `.env` lacks `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY`. |
| Stale UI in dev | Run `pnpm sync`, then reload/restart dev. |
| Fresh profile shows the landing page | Expected; the session is per WebView profile/origin. Sign in. |
| Broken image with spaces in the name | Should be fixed by `normaliseSpaceNames` in the sync; check the copied `dist`, not `../keel`. |
| First `tauri build` looks stuck | It is compiling Rust with LTO; allow 15–20 minutes. |
| Need CDP for testing | Temporarily add `"additionalBrowserArgs": "--remote-debugging-port=9222 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"` to the window config, run dev, then **remove it** before any release build. See [RUNBOOK](RUNBOOK.md). |
| Changing `identifier` loses the session/cache | The WebView data folder changes; sign in again. This is expected. |
