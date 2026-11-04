/**
 * Canary: prove that a fresh Keel build is still packageable.
 *
 * The desktop shell has no UI of its own, so nothing here fails when Keel adds
 * pages. It fails only when Keel breaks one of the assumptions the shell makes:
 *
 *   1. dist/index.html exists and every local asset it references exists.
 *   2. No asset filename contains a space (Tauri's asset server mis-serves those;
 *      the sync script normally normalises them, so a hit here means that broke).
 *   3. dist/version.json is written by Keel's version-json Vite plugin.
 *   4. The bundle still reads window.__TAURI_INTERNALS__ — that is how the
 *      offline layer decides it is running inside the desktop app. If the flag
 *      is renamed, the app silently behaves like the web build.
 *   5. No service worker registers while the app believes it is running in
 *      Tauri. WebView2 keeps a persistent profile, so a service worker would
 *      cache the shell and serve stale UI after `pnpm sync`.
 *
 * Then it loads the bundle in Chromium over a static server that mirrors
 * Tauri's asset fallback (exact -> path.html -> path/index.html -> index.html),
 * with window.__TAURI_INTERNALS__ injected so the desktop code paths run, and
 * fails on uncaught errors, an empty #root, or a service worker registration.
 * That catches white-screen regressions, which no amount of structural
 * checking would.
 *
 * Usage: node scripts/canary.mjs [--no-render]
 * Exits 1 on any failure. Screenshots land in canary-artifacts/.
 */
import { createServer } from "node:http";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, extname, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(desktopRoot, "dist");
const artifactDir = resolve(desktopRoot, "canary-artifacts");
const ROUTES = ["/", "/login", "/inventory", "/sales", "/settings"];
const RENDER = !process.argv.includes("--no-render");

const results = [];

function pass(name, detail = "") {
  results.push({ name, ok: true });
  console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
}

function warn(name, detail = "") {
  console.log(`  WARN  ${name}${detail ? `  — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n${title}`);
}

function toPosix(path) {
  return path.split("\\").join("/");
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function exists(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

let files = [];

async function loadDist() {
  const dir = await exists(dist);
  if (!dir?.isDirectory()) {
    fail("dist/ exists", `${dist} is missing — run pnpm sync first`);
    return false;
  }
  files = await walk(dist);
  return true;
}

// ---------------------------------------------------------------- structure

async function checkIndex() {
  const indexPath = join(dist, "index.html");
  const entry = await exists(indexPath);
  if (!entry?.isFile()) {
    fail("dist/index.html exists");
    return;
  }
  pass("dist/index.html exists", `${(entry.size / 1024).toFixed(1)} KB`);

  const html = await readFile(indexPath, "utf8");

  // Local refs only. Absolute URLs need the network and are reported separately.
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => !/^(https?:)?\/\//.test(href) && !href.startsWith("data:"));

  const missing = [];
  for (const ref of refs) {
    const clean = decodeURIComponent(ref.split("?")[0].split("#")[0]).replace(/^\/+/, "");
    if (!clean) continue;
    if (!(await exists(resolve(dist, clean)))) missing.push(ref);
  }

  if (missing.length === 0) {
    pass("index.html local references all exist", `${refs.length} checked`);
  } else {
    fail("index.html local references all exist", missing.join(", "));
  }

  const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((match) => match[1]);
  if (remote.length) {
    warn(
      "index.html references remote assets",
      `${remote.length} URL(s) need the network on first paint, e.g. ${remote[0]}`,
    );
  }
}

async function checkSpaces() {
  const spaced = files.filter((file) => /\s/.test(file.split(/[\\/]/).pop()));
  if (spaced.length === 0) {
    pass("no asset filenames contain spaces");
  } else {
    fail(
      "no asset filenames contain spaces",
      `${spaced.length} file(s), e.g. ${relative(dist, spaced[0])} — normaliseSpaceNames() did not run`,
    );
  }
}

async function checkVersionJson() {
  const path = join(dist, "version.json");
  const entry = await exists(path);
  if (!entry) {
    fail("dist/version.json exists", "Keel's version-json Vite plugin did not run");
    return;
  }
  try {
    const { buildTime } = JSON.parse(await readFile(path, "utf8"));
    if (typeof buildTime === "number" && buildTime > 0) {
      pass("dist/version.json has a buildTime", new Date(buildTime).toISOString());
    } else {
      fail("dist/version.json has a buildTime", String(buildTime));
    }
  } catch (error) {
    fail("dist/version.json is valid JSON", error.message);
  }
}

async function checkTauriFlag() {
  const scripts = files.filter((file) => file.endsWith(".js"));
  let found = null;
  for (const script of scripts) {
    const source = await readFile(script, "utf8");
    if (source.includes("__TAURI_INTERNALS__") || source.includes("__TAURI__")) {
      found = script;
      break;
    }
  }
  if (found) {
    pass("bundle still detects Tauri", "window.__TAURI_INTERNALS__ found");
  } else {
    fail(
      "bundle still detects Tauri",
      "no __TAURI_INTERNALS__/__TAURI__ reference in any built JS — the offline layer would silently run in web mode",
    );
  }
}

function noteServiceWorkerAsset() {
  // The string being present is not a failure: Keel keeps the registration for
  // the web build. Whether it actually registers under Tauri is asserted at
  // render time, with __TAURI_INTERNALS__ present.
  if (files.some((file) => /(^|[\\/])sw\.js$/.test(file))) {
    console.log("  INFO  dist ships sw.js — must not register under Tauri (checked in render)");
  }
}

// ------------------------------------------------------------------- render

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".map": "application/json",
};

/** Mirrors tauri::manager::AppManager::get_asset fallback order. */
async function resolveAsset(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, "").replace(/\/+$/, "");
  const candidates =
    clean === ""
      ? ["index.html"]
      : [clean, `${clean}.html`, `${clean}/index.html`, "index.html"];

  for (const candidate of candidates) {
    const full = resolve(dist, candidate);
    if (!full.startsWith(dist)) continue;
    const entry = await exists(full);
    if (entry?.isFile()) return full;
  }
  return null;
}

function startServer() {
  const server = createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    const file = await resolveAsset(pathname);
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    });
    res.end(body);
  });

  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port }));
  });
}

async function renderChecks() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("playwright is installed", "run pnpm install to add it");
    return;
  }

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  await mkdir(artifactDir, { recursive: true });

  try {
    for (const route of ROUTES) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));

      // Pretend to be the Tauri webview so isDesktop() takes the desktop branch.
      // Keel only reads this as a boolean; nothing calls invoke().
      await page.addInitScript(() => {
        window.__TAURI_INTERNALS__ = {};
      });

      const name = route === "/" ? "_root" : route.replace(/\//g, "_");

      try {
        await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForFunction(
          () => {
            const root = document.querySelector("#root");
            return !!root && root.children.length > 0;
          },
          null,
          { timeout: 20000 },
        );
        await page.waitForLoadState("load");

        if (pageErrors.length) {
          fail(`render ${route}`, `uncaught: ${pageErrors[0]}`);
          await page.screenshot({ path: join(artifactDir, `render${name}.png`) });
          continue;
        }

        // The registration fires on the window load event; give it a moment to land.
        await page.waitForTimeout(500);
        const registrations = await page.evaluate(async () => {
          if (!("serviceWorker" in navigator)) return 0;
          return (await navigator.serviceWorker.getRegistrations()).length;
        });

        if (registrations > 0) {
          fail(
            `render ${route}`,
            `${registrations} service worker registration(s) under Tauri — WebView2 would cache stale UI`,
          );
          await page.screenshot({ path: join(artifactDir, `render${name}.png`) });
        } else {
          pass(`render ${route}`, "mounted, no uncaught errors, no service worker");
        }
      } catch (error) {
        fail(`render ${route}`, error.message.split("\n")[0]);
        try {
          await page.screenshot({ path: join(artifactDir, `render${name}.png`) });
        } catch {
          // Best effort; the failure is already recorded.
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

// --------------------------------------------------------------------- main

console.log(`[canary] dist: ${toPosix(relative(desktopRoot, dist))}`);

if (await loadDist()) {
  section("Bundle structure");
  await checkIndex();
  await checkSpaces();
  await checkVersionJson();
  await checkTauriFlag();
  noteServiceWorkerAsset();

  if (RENDER) {
    section("Render");
    await renderChecks();
  } else {
    console.log("\n  SKIP  render checks (--no-render)");
  }
}

const failures = results.filter((result) => !result.ok);
console.log(
  `\n[canary] ${results.length - failures.length}/${results.length} checks passed` +
    (failures.length ? `, ${failures.length} failed` : ""),
);

if (failures.length) {
  console.log(`[canary] screenshots (if any): ${toPosix(relative(desktopRoot, artifactDir))}`);
  process.exit(1);
}
