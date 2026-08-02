import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const output = resolve(root, `codex-archive-importer-${manifest.version}.zip`);
await rm(output, { force: true });
execFileSync("zip", ["-qr", output, "codex-archive-importer"], {
  cwd: resolve(root, "release")
});
console.log(output);
