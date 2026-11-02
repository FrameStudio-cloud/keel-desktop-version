import { spawnSync } from "node:child_process";
import {
  existsSync,
  rmSync,
  cpSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const keelRoot = resolve(desktopRoot, "..", "keel");
const keelDist = resolve(keelRoot, "dist");
const desktopDist = resolve(desktopRoot, "dist");

function fail(msg) {
  console.error(`\n[sync-web] ERROR: ${msg}\n`);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Tauri's asset server returns index.html for a path containing a space, which
 * turns the login page's hero image into a broken image. The web deployment
 * encodes the URL correctly, but the packaged app should not depend on that
 * difference, so the copied bundle gets space-free filenames and its references
 * are rewritten. Only dist/ is touched; keel's source is never modified.
 */
function normaliseSpaceNames(root) {
  const renames = [];
  for (const file of walk(root)) {
    const name = basename(file);
    if (!/\s/.test(name)) continue;
    const safe = name.replace(/\s+/g, "-");
    const target = join(dirname(file), safe);
    if (existsSync(target)) continue;
    renameSync(file, target);
    renames.push([name, safe]);
  }
  if (renames.length === 0) return 0;

  const textExt = new Set([".js", ".css", ".html", ".json", ".webmanifest", ".xml", ".txt"]);
  for (const file of walk(root)) {
    if (!textExt.has(extname(file).toLowerCase())) continue;
    let source = readFileSync(file, "utf8");
    let changed = false;
    for (const [from, to] of renames) {
      if (source.includes(from)) {
        source = source.split(from).join(to);
        changed = true;
      }
      const encoded = encodeURIComponent(from);
      if (encoded !== from && source.includes(encoded)) {
        source = source.split(encoded).join(to);
        changed = true;
      }
    }
    if (changed) writeFileSync(file, source);
  }
  return renames.length;
}

if (!existsSync(keelRoot)) {
  fail(`Keel web app not found at ${keelRoot}. Expected a sibling "keel" folder.`);
}

if (!existsSync(resolve(keelRoot, "node_modules"))) {
  fail(`Keel node_modules not found at ${resolve(keelRoot, "node_modules")}. Run pnpm install in ../keel first.`);
}

console.log(`[sync-web] Building Keel web app in ${keelRoot}...`);
const build = spawnSync("pnpm", ["exec", "vite", "build"], {
  cwd: keelRoot,
  stdio: "inherit",
  shell: true,
});

if (build.error) {
  fail(`Failed to start vite build: ${build.error.message}`);
}
if (build.status !== 0) {
  fail(`vite build failed with exit code ${build.status}.`);
}

if (!existsSync(keelDist)) {
  fail(`vite build completed but ${keelDist} was not created.`);
}

console.log(`[sync-web] Removing existing ${desktopDist}...`);
if (existsSync(desktopDist)) {
  rmSync(desktopDist, { recursive: true, force: true });
}

console.log(`[sync-web] Copying ${keelDist} -> ${desktopDist}...`);
mkdirSync(desktopDist, { recursive: true });
cpSync(keelDist, desktopDist, { recursive: true });

const renamed = normaliseSpaceNames(desktopDist);
if (renamed) {
  console.log(`[sync-web] Normalised ${renamed} asset filename(s) containing spaces.`);
}

console.log("[sync-web] Sync complete.");
