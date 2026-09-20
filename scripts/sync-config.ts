// Usage: npm run config:sync -- --local | --remote
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSyncStatements, parseConfig } from "./sync-config-sql.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv.slice(2).find((arg) => arg === "--local" || arg === "--remote");
if (!target) {
  console.error("usage: npm run config:sync -- --local | --remote");
  process.exit(2);
}

const read = (name: string): unknown => JSON.parse(readFileSync(path.join(root, "config", name), "utf8"));
const config = parseConfig({
  topics: read("topics.json"),
  sources: read("sources.json"),
  authors: read("authors.json"),
  settings: read("settings.json"),
  stopEntities: read("stop-entities.json"),
});
const statements = buildSyncStatements(config);

const dir = mkdtempSync(path.join(tmpdir(), "radar-config-"));
const file = path.join(dir, "sync.sql");
try {
  writeFileSync(file, `${statements.join(";\n")};\n`);
  // The production config is used for --remote; the dev config owns the local database.
  const wranglerConfig = target === "--local" ? "wrangler.dev.jsonc" : "wrangler.jsonc";
  execFileSync("npx", ["wrangler", "d1", "execute", "content-radar", target, "--config", wranglerConfig, "--file", file, "--yes"], {
    cwd: path.join(root, "apps", "worker"),
    stdio: "inherit",
  });
  console.log(
    `synced ${config.topics.length} topics, ${config.sources.length} sources, ${config.authors.length} authors, ` +
      `${Object.keys(config.settings).length + 1} settings (${target.slice(2)})`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
