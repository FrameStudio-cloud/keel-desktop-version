import { spawnSync } from "node:child_process";
import { existsSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
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

console.log("[sync-web] Sync complete.");
