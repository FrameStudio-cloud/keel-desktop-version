/**
 * Stamp the desktop version into the Tauri manifests.
 *
 * Tauri reads the app version from src-tauri/tauri.conf.json, and the Rust
 * package carries its own copy in Cargo.toml. They must agree or the installer
 * filename and the app's reported version drift apart. The release workflow
 * calls this with the tag (v1.4.0 -> 1.4.0) before `pnpm build`.
 *
 * Usage: node scripts/stamp-version.mjs 1.4.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const configPath = resolve(desktopRoot, "src-tauri", "tauri.conf.json");
const cargoPath = resolve(desktopRoot, "src-tauri", "Cargo.toml");

const raw = process.argv[2] ?? "";
const version = raw.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    `[stamp-version] ERROR: "${raw}" is not a valid version. Expected 1.2.3 or 1.2.3-beta.1.`,
  );
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const previous = config.version;
config.version = version;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

// Only the [package] block carries the app version; dependency versions live in
// their own tables and must not be touched.
const cargo = readFileSync(cargoPath, "utf8");
const packageBlock = /\[package\][\s\S]*?(?=\n\[)/;
const block = cargo.match(packageBlock);
if (!block) {
  console.error("[stamp-version] ERROR: no [package] block in src-tauri/Cargo.toml.");
  process.exit(1);
}
const stamped = block[0].replace(/^version\s*=\s*".*"$/m, `version = "${version}"`);
if (stamped === block[0] && !block[0].includes(`version = "${version}"`)) {
  console.error("[stamp-version] ERROR: could not find a version line in [package].");
  process.exit(1);
}
writeFileSync(cargoPath, cargo.replace(packageBlock, stamped));

console.log(`[stamp-version] ${previous} -> ${version}`);
console.log(`[stamp-version] updated src-tauri/tauri.conf.json and src-tauri/Cargo.toml`);
