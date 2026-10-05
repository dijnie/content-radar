// Prints the soak report: every query of scripts/soak-report.sql with its rows.
//   npm run soak-report -- --remote | --local
// `wrangler d1 execute --file` cannot be used for this on a remote database: it goes through
// the bulk import path and answers with a summary ("17 queries executed"), not with rows.
// Statements sent with --command do return their result sets, so they are sent that way.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDeployConfig } from "./deploy-config.ts";

const target = process.argv.slice(2).find((arg) => arg === "--local" || arg === "--remote");
if (!target) {
  console.error("usage: npm run soak-report -- --remote | --local");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each query is introduced by a `-- status:` or `-- soak:` comment, which becomes its title. */
export function parseReport(sql: string): { title: string; sql: string }[] {
  const queries: { title: string; sql: string }[] = [];
  let title: string | null = null;
  let body: string[] = [];
  const flush = () => {
    const statement = body.join("\n").trim().replace(/;$/, "");
    if (title !== null && statement) queries.push({ title, sql: statement });
    body = [];
  };
  for (const line of sql.split("\n")) {
    const heading = /^--\s*((?:status|soak):.*)$/.exec(line.trim());
    if (heading) {
      flush();
      title = heading[1]!;
    } else if (!line.trim().startsWith("--")) {
      body.push(line);
    }
  }
  flush();
  return queries;
}

const queries = parseReport(readFileSync(path.join(root, "scripts", "soak-report.sql"), "utf8"));
const config = target === "--local" ? "wrangler.dev.jsonc" : "wrangler.jsonc";
if (target === "--remote") writeDeployConfig();
const out = execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "DB", target, "--config", config, "--json", "--command", queries.map((query) => query.sql).join(";\n")],
  { cwd: path.join(root, "apps", "worker"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const results = JSON.parse(out) as { success: boolean; results: Record<string, unknown>[] }[];
if (results.length !== queries.length) throw new Error(`expected ${queries.length} result sets, got ${results.length}`);

console.log(`# Soak report ${new Date().toISOString()} (${target.slice(2)})`);
for (const [index, query] of queries.entries()) {
  const rows = results[index]!.results;
  console.log(`\n## ${query.title}  [${rows.length} row${rows.length === 1 ? "" : "s"}]`);
  if (rows.length > 0) console.table(rows);
}
