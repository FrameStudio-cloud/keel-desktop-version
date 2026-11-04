/**
 * Build the `latest.json` manifest the Tauri updater polls.
 *
 * Tauri reads `platforms[<target>].url` and `.signature`, compares `version`
 * with the running app, and refuses the download if the installer's signature
 * does not match the public key baked into tauri.conf.json. Publishing this file
 * next to the installers is what makes the update endpoint real:
 *
 *   releases/latest/download/latest.json
 *
 * Usage:
 *   node scripts/make-latest-json.mjs \
 *     --version 0.1.1 --tag v0.1.1 --repo owner/repo \
 *     --artifact Keel_0.1.1_x64-setup.exe \
 *     --signature-file path/to/Keel_0.1.1_x64-setup.exe.sig \
 *     --notes-file release-notes.md --out out/latest.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    tag: { type: "string" },
    repo: { type: "string" },
    artifact: { type: "string" },
    "signature-file": { type: "string" },
    "notes-file": { type: "string" },
    platform: { type: "string", default: "windows-x86_64" },
    out: { type: "string", default: "latest.json" },
  },
});

function required(name) {
  const value = values[name];
  if (!value) {
    console.error(`[latest-json] ERROR: --${name} is required.`);
    process.exit(1);
  }
  return value;
}

const version = required("version");
const tag = required("tag");
const repo = required("repo");
const artifact = required("artifact");
const signatureFile = required("signature-file");
const platform = values.platform;
const out = values.out;

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[latest-json] ERROR: "${version}" is not a valid version.`);
  process.exit(1);
}

const signature = (await readFile(signatureFile, "utf8")).trim();
if (!signature) {
  console.error(`[latest-json] ERROR: ${signatureFile} is empty.`);
  process.exit(1);
}

let notes = "";
if (values["notes-file"]) {
  notes = (await readFile(values["notes-file"], "utf8")).trim();
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [platform]: {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(artifact)}`,
    },
  },
};

await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[latest-json] ${out}`);
console.log(`[latest-json] version ${version} -> ${platform}`);
console.log(`[latest-json] url ${manifest.platforms[platform].url}`);
