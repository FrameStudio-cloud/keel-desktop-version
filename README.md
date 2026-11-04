# Keel Desktop

A Tauri v2 shell that packages the Keel web dashboard as a Windows desktop app.

**The UI is not written here.** Every page, style and data access rule lives in
`../keel`. This repository owns the desktop shell, the packaging, and the
documentation and verification of the offline layer that ships inside Keel's
built output.

## How it fits together

```
../keel  ──vite build──►  ../keel/dist  ──sync──►  ./dist  ──Tauri──►  Keel.exe
```

- `scripts/sync-web.mjs` builds `../keel` with its own `node_modules`, deletes
  `./dist`, copies the fresh build in, and normalises asset filenames that
  contain spaces (Tauri's asset server otherwise returns `index.html` for them).
- `pnpm build` runs `sync` first, then `tauri build`, so an installer can never
  contain an older web bundle than the source.
- `src-tauri/tauri.conf.json` points at `../dist` — there is **no remote URL**
  and no `devUrl`. The app always loads its own local bundle.

## Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Node | 20.19+ or 22.12+ | Tested on 24.14 |
| pnpm | any recent | This repo's Node packages use pnpm |
| npm | ships with Node | Keel is an npm project (`package-lock.json`) |
| Rust | stable | `cargo` + `rustc` on PATH |
| MSVC build tools | 2022 | Required by the Rust linker on Windows |
| WebView2 | bundled with Windows 10/11 | Tauri's runtime |
| Tauri CLI | `@tauri-apps/cli` devDependency | Use `pnpm tauri`, no global install needed |

## Commands

```bash
pnpm install       # install the Tauri CLI
pnpm sync          # build ../keel and refresh ./dist
pnpm tauri dev     # run the app against ./dist
pnpm build         # sync + release build + installers
```

The sync looks for a sibling folder named `keel`. If the checkout is somewhere
else, point it explicitly:

```bash
KEEL_ROOT=C:/path/to/keel pnpm sync      # bash
$env:KEEL_ROOT="C:\path\to\keel"; pnpm sync   # PowerShell
```

Release output:

- `src-tauri/target/release/keel-desktop.exe`
- `src-tauri/target/release/bundle/msi/Keel_0.1.0_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/Keel_0.1.0_x64-setup.exe`

The first release build compiles ~349 Rust crates and takes 15–20 minutes.
Later builds are incremental.

## Releases

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds the
installer on GitHub and attaches it to a release. Push a tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

It checks out `FrameStudio-cloud/keel` next to this repo, stamps the tag version
into `tauri.conf.json` and `Cargo.toml`, runs `pnpm build`, and uploads the MSI,
the NSIS installer and a `BUILD-INFO.txt` recording the exact Keel commit. Run
it manually from the Actions tab to build a specific Keel ref without releasing.

Required repository secrets:

| Secret | Purpose |
|---|---|
| `KEEL_REPO_TOKEN` | Fine-grained PAT with **Contents: read** on `FrameStudio-cloud/keel` (it is private) |
| `VITE_SUPABASE_URL` | Baked into the Keel bundle at build time |
| `VITE_SUPABASE_ANON_KEY` | Baked into the Keel bundle at build time |

## Offline behaviour

Version 1 covers **staying signed in, reading the last data, and queuing counter
sales**:

- the session survives a failed token refresh;
- `shop_id` and the settings snapshot are cached and applied before any network
  request;
- Overview, Inventory and Sales read from an IndexedDB cache on launch;
- a sale is written through one atomic, idempotent `log_sale` RPC; when offline
  it goes to a durable outbox and replays on reconnect, with a "Pending sync"
  badge in the Sales list and on the receipt;
- an "Offline — showing saved data" pill appears when the machine is offline.

Expenses, stock adjustments, orders and invoices still require the network. See
[`docs/OFFLINE.md`](docs/OFFLINE.md) for the read cache, and
[`docs/OFFLINE-SALES-PLAN.md`](docs/OFFLINE-SALES-PLAN.md) for the sales slice.
The full write-path study is in [`docs/WRITE-PATHS.md`](docs/WRITE-PATHS.md).

## Repository layout

```
.
├── .github/
│   └── workflows/
│       └── release.yml       # tag -> installer + GitHub release
├── scripts/
│   ├── sync-web.mjs          # build ../keel, refresh ./dist, normalise names
│   └── stamp-version.mjs     # write the tag version into the Tauri manifests
├── src-tauri/
│   ├── src/                  # Rust entry point (Tauri scaffold)
│   ├── icons/
│   ├── tauri.conf.json       # app name, identifier, window, frontendDist
│   └── Cargo.toml
├── dist/                     # generated: the Keel web build (git-ignored)
├── docs/
│   ├── README.md             # documentation index
│   ├── ARCHITECTURE.md       # shell + read/write architecture
│   ├── SETUP.md              # prerequisites, dev, build
│   ├── OFFLINE.md            # read cache + session/settings
│   ├── OFFLINE-SALES-PLAN.md # log_sale + outbox + pending UI
│   ├── WRITE-PATHS.md        # all write surfaces + study
│   ├── RUNBOOK.md            # apply/verify/test/rebuild
│   ├── ROADMAP.md            # next slices + decisions
│   ├── SESSION-LOG.md        # dated build log
│   └── sql/
│       └── verify-log-sale.sql
└── package.json              # sync / build / tauri scripts
```

## Documentation

Start at [`docs/README.md`](docs/README.md). It indexes the architecture, setup,
read cache, sales write path, the full write-path study, the runbook and the
roadmap.

## Configuration

`src-tauri/tauri.conf.json`:

- `productName`: `Keel`
- `identifier`: `keel.framestudio.co.ke`
- `build.frontendDist`: `../dist`
- window: 1280×800, title `Keel`
- `withGlobalTauri`: `true` (the offline layer detects Tauri through it)

Do **not** add `additionalBrowserArgs: "--remote-debugging-port=…"` to a
release build. It is useful only for local CDP testing and must be removed
before packaging.

## Troubleshooting

- **Stale UI in dev:** run `pnpm sync`, then reload/restart the dev app. Tauri
  dev serves `dist` over `127.0.0.1:1430`, so a sync is enough — no Rust
  rebuild.
- **`Keel web app not found`:** the sibling `keel` folder is missing or named
  differently. Clone it next to this repo, or set `KEEL_ROOT` to its path.
- **A fresh WebView profile shows the landing page:** that is expected. The
  persisted session is per WebView origin/profile. Use the normal app profile,
  or sign in.
- **Broken image with spaces in the filename:** should not happen after sync;
  `normaliseSpaceNames()` renames those files in the copied bundle and rewrites
  references in JS/CSS/HTML.
- **First `tauri build` looks stuck:** it is compiling Rust with LTO. Check the
  log; a clean first build is 15–20 minutes on this machine.
- **Changing `src-tauri/*` restarts the dev app** (the Tauri watcher rebuilds);
  changing keel requires `pnpm sync` because the watcher does not watch
  `../keel`.

## Scope

This repo is a shell. Do not add pages, product features or data logic here.
Those belong in `../keel`. The only desktop-specific code is:

- the sync script,
- the Tauri configuration,
- the offline layer's build-time asset normalisation.
