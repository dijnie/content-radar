// Re-runs the CPM resolution sweep on real data exported from D1.
//   node scripts/resolution-sweep.ts --local | --remote
// It rebuilds this window's weighted edges exactly as the hourly job does, sweeps
// gamma, and prints the plateau. Apply a new value through `core_overrides` in
// config/settings.json (then `npm run config:sync`), never by editing code.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDeployConfig } from "./deploy-config.ts";
import { MEASUREMENT_MODELS_SQL, storedMeasurement } from "../apps/worker/src/db/measurement-models.ts";
import { leidenClusterer, resolutionSweep, resolveParams, weightedEdges } from "../packages/core/src/index.ts";

const target = process.argv.slice(2).find((arg) => arg === "--local" || arg === "--remote");
if (!target) {
  console.error("usage: node scripts/resolution-sweep.ts --local | --remote");
  process.exit(2);
}
const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "worker");
if (target === "--remote") writeDeployConfig(undefined, undefined, { databaseCommands: true });

function query<T>(sql: string): T[] {
  const config = target === "--local" ? "wrangler.dev.jsonc" : "wrangler.jsonc";
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", target!, "--config", config, "--json", "--command", sql], { cwd: workerDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return (JSON.parse(out) as { results: T[] }[])[0]!.results;
}

const overrides = query<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'core_overrides'")[0];
const params = resolveParams(overrides ? (JSON.parse(overrides.value_json) as Record<string, unknown>) : {});
const since = Math.floor(Date.now() / 1000) - params.windowDays * 86_400;

const claims = query<{ id: number; item_id: number; published_at: number; text_en: string; models: string | null }>(`SELECT c.id, item_id, published_at, text_en, ${MEASUREMENT_MODELS_SQL} AS models FROM claims c WHERE published_at >= ${since}`);
const cosineEdges = query<{ claim_a: number; claim_b: number; cosine: number }>(
  `SELECT e.claim_a, e.claim_b, e.cosine FROM claim_edges e JOIN claims a ON a.id = e.claim_a JOIN claims b ON b.id = e.claim_b WHERE a.published_at >= ${since} AND b.published_at >= ${since}`,
);
const mentions = query<{ claim_id: number; entity_id: number }>(
  `SELECT m.claim_id, m.entity_id FROM entity_mentions m JOIN claims c ON c.id = m.claim_id WHERE m.entity_id IS NOT NULL AND c.published_at >= ${since}`,
);
const stopNames = new Set(JSON.parse(query<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'stop_entities'")[0]?.value_json ?? "[]") as string[]);
const stopIds = new Set(query<{ alias_normalized: string; entity_id: number }>("SELECT alias_normalized, entity_id FROM entity_aliases").filter((row) => stopNames.has(row.alias_normalized)).map((row) => row.entity_id));

const entityIdsByClaim = new Map<number, number[]>(claims.map((claim) => [claim.id, []]));
for (const mention of mentions) entityIdsByClaim.get(mention.claim_id)?.push(mention.entity_id);
const edges = weightedEdges(
  claims.map((claim) => ({ id: claim.id, itemId: claim.item_id, publishedAt: claim.published_at, measurement: storedMeasurement(claim.text_en, claim.models) })),
  cosineEdges.map((edge) => ({ claimA: edge.claim_a, claimB: edge.claim_b, cosine: edge.cosine })),
  entityIdsByClaim, stopIds, params,
);

console.log(`window: ${params.windowDays} days | claims: ${claims.length} | cosine edges: ${cosineEdges.length} | weighted edges: ${edges.length} | current resolution: ${params.resolution}`);
if (edges.length === 0) {
  console.log("no edges in the window yet; nothing to sweep");
  process.exit(0);
}
const grid = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.8];
const sweep = resolutionSweep(leidenClusterer, claims.map((claim) => claim.id), edges, grid, { seed: params.seed, quality: params.quality, minCommunitySize: params.minCommunitySize });
console.table(sweep.points);
console.log("stable range:", sweep.stableRange, "| recommended:", sweep.recommended);
console.log("A plateau is a hint, not a verdict: open 20 stories at the candidate value and check each is one coherent story.");
