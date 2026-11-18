import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";
import type templateConfig from "../wrangler.json";

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
}).superRefine((values, ctx) => {
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
  d1_databases: { binding: string; migrations_dir: string; database_name?: string; database_id?: string }[];
};

export function writeDeployConfig(root = projectRoot, environment: NodeJS.ProcessEnv = process.env, options: { databaseCommands?: boolean } = {}) {
  // Validate everything before touching an existing deployment configuration.
  const values = readSetup(root, environment);
  const template = JSON.parse(readFileSync(path.join(root, "wrangler.json"), "utf8")) as DeployConfig;
  const db = template.d1_databases.find(binding => binding.binding === "DB");
  if (!db) throw new Error("Missing DB binding in wrangler.json");
  const provisioned = !!db.database_id && db.database_id !== "00000000-0000-0000-0000-000000000000";
  if (!provisioned && options.databaseCommands && !values.D1_DATABASE_NAME) {
    throw new Error("Database CLI commands need D1_DATABASE_NAME set to the database attached as DB in Worker > Bindings. Deploy uses that binding directly and needs no database name or ID.");
  }
  const workerDir = path.join(root, "apps/worker");
  const fromWorker = (resource: string) => path.relative(workerDir, path.resolve(root, resource));
  template.$schema = fromWorker(template.$schema);
  template.main = fromWorker(template.main);
  template.assets.directory = fromWorker(template.assets.directory);
  db.migrations_dir = fromWorker(db.migrations_dir);
  if (values.CLOUDFLARE_ACCOUNT_ID) template.account_id = values.CLOUDFLARE_ACCOUNT_ID;
  if (!provisioned) {
    // The original repository deploys to the existing dashboard binding.
    delete db.database_id;
    delete db.database_name;
    if (options.databaseCommands && values.D1_DATABASE_NAME) db.database_name = values.D1_DATABASE_NAME;
    template.name = values.WORKER_NAME;
    template.r2_buckets[0]!.bucket_name = values.R2_BUCKET_NAME;
  }
  const queueNames = new Map<string, string>();
  const queueRoles = [
    ["POLL_QUEUE", "POLL_QUEUE_NAME", "radar-poll"],
    ["LLM_QUEUE", "LLM_QUEUE_NAME", "radar-llm"],
    ["DLQ", "DLQ_QUEUE_NAME", "radar-dlq"],
  ] as const;
  for (const [binding, variable, defaultName] of queueRoles) {
    const producer = template.queues.producers.find(q => q.binding === binding);
    if (!producer) throw new Error(`Missing queue binding ${binding} in wrangler.json`);
    const name = provisioned ? producer.queue : values[variable];
    queueNames.set(defaultName, name);
    producer.queue = name;
    template.vars[variable] = name;
  }
  for (const consumer of template.queues.consumers) {
    // The template wizard can rename the queues. Use their producer bindings as the source of truth.
    if (!provisioned || !template.queues.producers.some(q => q.queue === consumer.queue)) consumer.queue = queueNames.get(consumer.queue) ?? consumer.queue;
    if (consumer.dead_letter_queue) consumer.dead_letter_queue = template.vars.DLQ_QUEUE_NAME!;
  }
  // The third producer exposes the dead-letter queue in the template form only.
  if (!provisioned) template.queues.producers = template.queues.producers.filter(q => q.binding !== "DLQ");
  const output = path.join(workerDir, "wrangler.jsonc");
  writeFileSync(output, `// Generated by npm run setup from wrangler.json.\n${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
  return { output, provisioned };
}
