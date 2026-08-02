import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const release = resolve(root, "release", "codex-archive-importer");
await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

const compiled = await readFile(resolve(root, "build", "main.js"), "utf8");
// Obsidian expects the CommonJS module itself to be the plugin class. The
// build copy keeps named exports for self-tests; the release copy exports only
// the default plugin class.
await writeFile(resolve(release, "main.js"), `${compiled}\nmodule.exports = exports.default;\n`);
await Promise.all([
  copyFile(resolve(root, "manifest.json"), resolve(release, "manifest.json")),
  copyFile(resolve(root, "styles.css"), resolve(release, "styles.css")),
]);
console.log(`Release files prepared in ${release}`);
