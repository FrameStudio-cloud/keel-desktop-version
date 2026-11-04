# Setup and build

## Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Node | 20.19+ or 22.12+ | Tested on 24.14 |
| pnpm | any recent | This repo uses pnpm |
| npm | ships with Node | Keel itself is an npm project (`package-lock.json`) |
| Rust | stable | `cargo` + `rustc` on PATH |
| MSVC build tools | 2022 | Required by the Rust linker on Windows |
| WebView2 | bundled with Windows 10/11 | Tauri's runtime |
| Tauri CLI | `@tauri-apps/cli` devDependency | Use `pnpm tauri`; no global install |

The **Keel web repo** must already have its own `node_modules` and a `.env` with
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The desktop sync runs
`vite build` there; the Vite config throws if those are missing. The desktop
repo has no `.env` of its own.

By default that repo is the sibling folder `../keel`. Any other location works
by setting `KEEL_ROOT` (absolute, or relative to this repo):

```bash
KEEL_ROOT=C:/code/keel pnpm sync
```

CI uses this: it checks Keel out into `./keel` inside the workspace and sets
`KEEL_ROOT=keel`.

## Install

```bash
cd keel-desktop
pnpm install

cd ../keel
npm ci
```

The desktop repo has no runtime dependencies of its own beyond the Tauri CLI;
Keel's install is what produces the UI that gets packaged.

## Commands

```bash
pnpm sync        # build ../keel and refresh ./dist
pnpm tauri dev   # run the desktop app against ./dist
pnpm build       # sync + release build + MSI/NSIS
```

### `pnpm sync`

`scripts/sync-web.mjs`:

1. Resolves the Keel root: `KEEL_ROOT` if set, otherwise the sibling `../keel`.
2. Verifies that root and its `node_modules` exist.
3. Runs `pnpm exec vite build` there.
4. Deletes `./dist`.
5. Copies `<keel>/dist` into `./dist`.
6. Renames any asset filename containing spaces and rewrites references in the
   copied JS/CSS/HTML. (Tauri's asset server returns `index.html` for a path with
   a space; the login hero image was broken without this.)
7. Fails loudly if the build fails or produces no `dist`.

It never modifies the Keel source or its `dist`.

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

## CI releases

`.github/workflows/release.yml` produces the installer without a local Rust
toolchain. Two triggers:

- a `v*` tag — builds and publishes a GitHub release with the installers;
- `workflow_dispatch` — builds and uploads artifacts only, with optional
  `version` and `keel_ref` inputs.

What it does:

1. Checks this repo out, then `FrameStudio-cloud/keel` into `./keel`.
2. Installs desktop deps with `pnpm install --frozen-lockfile` and Keel deps with
   `npm ci` (Keel ships `package-lock.json`; the desktop repo uses pnpm).
3. `node scripts/stamp-version.mjs <version>` — writes the tag version into
   `src-tauri/tauri.conf.json` and the `[package]` version in `Cargo.toml`.
   `v0.2.0` becomes `0.2.0`, so the installer is `Keel_0.2.0_x64_en-US.msi`.
4. `pnpm build` with `KEEL_ROOT=keel`.
5. Uploads the MSI, the NSIS setup and `BUILD-INFO.txt` (desktop commit, Keel
   commit, Keel ref, UTC timestamp).

Repository secrets:

| Secret | Required | Purpose |
|---|---|---|
| `KEEL_REPO_TOKEN` | Yes | Fine-grained PAT, **Contents: read** on `FrameStudio-cloud/keel`. It is private, so the runner cannot use its own token. |
| `VITE_SUPABASE_URL` | Yes | Passed to the Keel build; Vite bakes it into the bundle. |
| `VITE_SUPABASE_ANON_KEY` | Yes | Same. The anon key is public by design, but it is still supplied as a secret so no value is committed. |
| `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`, `VITE_PAYSTACK_PUBLIC_KEY`, `VITE_GOOGLE_CLIENT_ID` | No | Without them the build succeeds but analytics, payments and Google Calendar are silently absent from the installer. |

The workflow fails fast with a `::error::` annotation naming whichever secret is
missing, rather than failing later inside Vite with a bare
`Missing VITE_SUPABASE_URL`.

Local builds are unchanged: they read `../keel/.env`, so the secrets are only
needed for CI.

## Canary

`pnpm canary` checks the synced bundle, not the Rust shell, so it needs neither
Rust nor Tauri. It is the guard against Keel changes that break the desktop app
without breaking `keel` itself.

Structural checks:

1. `dist/index.html` exists, and every local `src`/`href` it references exists.
2. No asset filename contains a space.
3. `dist/version.json` exists with a numeric `buildTime`.
4. Some built JS still references `__TAURI_INTERNALS__`/`__TAURI__`.
5. `dist/sw.js` may exist (the web build needs it) but must not register.

Then it serves `dist` with a static server that mirrors Tauri's asset fallback
and loads `/`, `/login`, `/inventory`, `/sales`, `/settings` in Chromium with
`__TAURI_INTERNALS__` injected, so the desktop branches actually run. Each route
must mount a non-empty `#root`, throw no uncaught error, and register no service
worker. Screenshots go to `canary-artifacts/` on failure.

Run it after any `pnpm sync` when Keel changed something structural: routing,
the built entry, Vite config, the desktop flag, analytics or service workers.

`--no-render` runs only the structural checks (no Playwright, no browser).

`.github/workflows/canary.yml` runs the full check nightly at 03:00 UTC against
Keel `main`, plus on demand with an optional `keel_ref`. It needs the same
`KEEL_REPO_TOKEN` and `VITE_SUPABASE_*` secrets as the release workflow.

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
| `Keel web app not found` | The sibling `keel` folder is missing. Clone it next to this repo, or set `KEEL_ROOT` to its path. |
| `Keel node_modules not found` | Run `pnpm install` in the Keel checkout (`KEEL_ROOT` if set). |
| `vite build failed` / missing env | Keel's `.env` lacks `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY`. |
| Stale UI in dev | Run `pnpm sync`, then reload/restart dev. |
| Fresh profile shows the landing page | Expected; the session is per WebView profile/origin. Sign in. |
| Broken image with spaces in the name | Should be fixed by `normaliseSpaceNames` in the sync; check the copied `dist`, not `../keel`. |
| First `tauri build` looks stuck | It is compiling Rust with LTO; allow 15–20 minutes. |
| Need CDP for testing | Temporarily add `"additionalBrowserArgs": "--remote-debugging-port=9222 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"` to the window config, run dev, then **remove it** before any release build. See [RUNBOOK](RUNBOOK.md). |
| Changing `identifier` loses the session/cache | The WebView data folder changes; sign in again. This is expected. |
