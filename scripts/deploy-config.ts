import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";
import type templateConfig from "../apps/worker/wrangler.template.json";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, hyphens or underscores");
const optionalValue = (value: unknown) => typeof value === "string" && !value.trim() ? undefined : value;
const schema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.preprocess(optionalValue, z.string().trim().regex(/^[a-f0-9]{32}$/i, "Enter the 32-character Cloudflare account ID").optional()),
  WORKER_NAME: name.default("content-radar"),
  // Only used by explicit database CLI commands. Deployment inherits the Worker's DB binding.
  D1_DATABASE_NAME: z.preprocess(optionalValue, name.optional()),
  R2_BUCKET_NAME: name.default("content-radar-raw"),
  POLL_QUEUE_NAME: name.default("radar-poll"),
  LLM_QUEUE_NAME: name.default("radar-llm"),
  DLQ_QUEUE_NAME: name.default("radar-dlq"),
  LLM_ENDPOINT: z.string().trim().optional(),
  LLM_MODEL: z.string().trim().optional(),
}).superRefine((values, ctx) => {
  if ((values.LLM_ENDPOINT === undefined) !== (values.LLM_MODEL === undefined) || Boolean(values.LLM_ENDPOINT) !== Boolean(values.LLM_MODEL)) {
    ctx.addIssue({ code: "custom", path: ["LLM_ENDPOINT", "LLM_MODEL"], message: "Omit both fields to keep dashboard values, fill both to override, or set both empty to pause LLM processing" });
  }
  if (values.LLM_ENDPOINT) {
    try {
      const url = new URL(values.LLM_ENDPOINT);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    } catch {
      ctx.addIssue({ code: "custom", path: ["LLM_ENDPOINT"], message: "Use an HTTP(S) API URL without embedded credentials or fragments; put the API key in LLM_API_KEY" });
    }
  }
  if (new Set([values.POLL_QUEUE_NAME, values.LLM_QUEUE_NAME, values.DLQ_QUEUE_NAME]).size !== 3) {
    ctx.addIssue({ code: "custom", path: ["POLL_QUEUE_NAME", "LLM_QUEUE_NAME", "DLQ_QUEUE_NAME"], message: "Use three different queue names" });
  }
});

export function readSetup(root = projectRoot, environment: NodeJS.ProcessEnv = process.env) {
  const file = path.join(root, ".env.setup");
  const local = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const result = schema.safeParse({ ...local, ...environment });
  if (!result.success) {
    throw new Error(`Setup incomplete:\n${result.error.issues.map((issue) => `- ${issue.path.join(" / ")}: ${issue.message}`).join("\n")}\nCopy .env.setup.example to .env.setup and fill it in, or set these variables in Cloudflare Builds.`);
  }
  return result.data;
}

type DeployConfig = Omit<typeof templateConfig, "vars" | "d1_databases"> & {
  account_id?: string;
  vars: Record<string, string>;
  d1_databases: { binding: string; migrations_dir: string; database_name?: string }[];
};

export function writeDeployConfig(root = projectRoot, environment: NodeJS.ProcessEnv = process.env, options: { databaseCommands?: boolean } = {}) {
  // Validate everything before touching an existing deployment configuration.
  const values = readSetup(root, environment);
  if (options.databaseCommands && !values.D1_DATABASE_NAME) {
    throw new Error("Database CLI commands need D1_DATABASE_NAME set to the database attached as DB in Worker > Bindings. Deploy uses that binding directly and needs no database name or ID.");
  }
  const template = JSON.parse(readFileSync(path.join(root, "apps/worker/wrangler.template.json"), "utf8")) as DeployConfig;
  if (values.CLOUDFLARE_ACCOUNT_ID) template.account_id = values.CLOUDFLARE_ACCOUNT_ID;
  template.name = values.WORKER_NAME;
  // No name or ID on deployment: Wrangler reuses the DB binding already selected on the Worker.
  // Direct D1 CLI commands resolve by database name, not by a Worker's deployed binding.
  if (options.databaseCommands && values.D1_DATABASE_NAME) template.d1_databases[0]!.database_name = values.D1_DATABASE_NAME;
  template.r2_buckets[0]!.bucket_name = values.R2_BUCKET_NAME;
  if (values.LLM_ENDPOINT !== undefined && values.LLM_MODEL !== undefined) {
    template.vars.LLM_ENDPOINT = values.LLM_ENDPOINT;
    template.vars.LLM_MODEL = values.LLM_MODEL;
  }
  template.vars.POLL_QUEUE_NAME = values.POLL_QUEUE_NAME;
  template.vars.LLM_QUEUE_NAME = values.LLM_QUEUE_NAME;
  template.vars.DLQ_QUEUE_NAME = values.DLQ_QUEUE_NAME;
  const queues: Record<string, string> = {
    "radar-poll": values.POLL_QUEUE_NAME,
    "radar-llm": values.LLM_QUEUE_NAME,
    "radar-dlq": values.DLQ_QUEUE_NAME,
  };
  for (const queue of [...template.queues.producers, ...template.queues.consumers]) {
    const resolved = queues[queue.queue];
    if (!resolved) throw new Error("Unknown queue in wrangler.template.json; update the setup mapping");
    queue.queue = resolved;
    if ("dead_letter_queue" in queue && queue.dead_letter_queue) queue.dead_letter_queue = values.DLQ_QUEUE_NAME;
  }
  const output = path.join(root, "apps/worker/wrangler.jsonc");
  writeFileSync(output, `// Generated by npm run setup. Edit .env.setup or build variables, and wrangler.template.json.\n${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
  return { output, llmEnabled: values.LLM_MODEL === undefined ? null : Boolean(values.LLM_MODEL) };
}
