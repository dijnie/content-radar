import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { projectRoot, readSetup, writeDeployConfig } from "./deploy-config.ts";

const valid = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "radar-setup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "apps/worker"), { recursive: true });
  cpSync(path.join(projectRoot, "wrangler.json"), path.join(root, "wrangler.json"));
  return root;
}

test("dashboard deployments need no account or database IDs and preserve runtime variables", (t) => {
  const { output } = writeDeployConfig(fixture(t), {});
  const config = JSON.parse(readFileSync(output, "utf8").split("\n").slice(1).join("\n"));
  assert.deepEqual(config.d1_databases, [{ binding: "DB", migrations_dir: "migrations" }]);
  assert.equal(config.account_id, undefined);
  assert.equal(config.keep_vars, true);
  assert.equal(config.vars.LLM_ENDPOINT, undefined);
  assert.equal(config.vars.LLM_MODEL, undefined);
  assert.equal(config.vars.EMBEDDING_MODEL, undefined);
  assert.equal(config.ai, undefined);
});

test("a template clone uses its provisioned resources for deploy and database commands", (t) => {
  const root = fixture(t);
  const file = path.join(root, "wrangler.json");
  const source = JSON.parse(readFileSync(file, "utf8"));
  source.name = "my-radar";
  Object.assign(source.d1_databases[0], { database_name: "my-db", database_id: "3d456789-1234-4321-8765-123456789abc" });
  source.r2_buckets[0].bucket_name = "my-raw";
  for (const producer of source.queues.producers) producer.queue = "my-" + producer.queue;
  writeFileSync(file, JSON.stringify(source));
  for (const databaseCommands of [false, true]) {
    const { output, provisioned } = writeDeployConfig(root, {}, { databaseCommands });
    assert.ok(provisioned);
    const cfg = JSON.parse(readFileSync(output, "utf8").split("\n").slice(1).join("\n"));
    assert.equal(cfg.name, source.name);
    assert.deepEqual(cfg.r2_buckets, source.r2_buckets);
    assert.deepEqual(cfg.d1_databases, [{ ...source.d1_databases[0], migrations_dir: "migrations" }]);
    assert.deepEqual(cfg.queues.producers, source.queues.producers);
    assert.deepEqual(cfg.queues.consumers.map((q: { queue: string }) => q.queue), ["my-radar-poll", "my-radar-llm", "my-radar-dlq"]);
    assert.equal(cfg.queues.consumers[0].dead_letter_queue, "my-radar-dlq");
    assert.equal(cfg.vars.LLM_QUEUE_NAME, "my-radar-llm");
    assert.equal(cfg.main, "src/index.ts");
    assert.equal(cfg.assets.directory, "../web/dist");
  }
});

test("legacy IDs and database names cannot replace the dashboard binding on deploy", (t) => {
  const { output } = writeDeployConfig(fixture(t), {
    CLOUDFLARE_ACCOUNT_ID: "", D1_DATABASE_ID: "old-account-database-id", D1_DATABASE_NAME: "old-database",
  });
  const text = readFileSync(output, "utf8");
  assert.doesNotMatch(text, /old-account-database-id|old-database|database_id|database_name|account_id/);
});

test("invalid account selection does not replace a working config", (t) => {
  const root = fixture(t);
  const output = path.join(root, "apps/worker/wrangler.jsonc");
  writeFileSync(output, "existing configuration");
  assert.throws(() => writeDeployConfig(root, { CLOUDFLARE_ACCOUNT_ID: "not-an-account-id" }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(readFileSync(output, "utf8"), "existing configuration");
});

test("database CLI commands require an explicit target instead of guessing the bound database", (t) => {
  const root = fixture(t);
  const existing = writeDeployConfig(root, {});
  const before = readFileSync(existing.output, "utf8");
  assert.throws(() => writeDeployConfig(root, {}, { databaseCommands: true }), /D1_DATABASE_NAME/);
  assert.equal(readFileSync(existing.output, "utf8"), before);
  const { output } = writeDeployConfig(root, { D1_DATABASE_NAME: "selected-db" }, { databaseCommands: true });
  const config = JSON.parse(readFileSync(output, "utf8").split("\n").slice(1).join("\n"));
  assert.deepEqual(config.d1_databases, [{ binding: "DB", migrations_dir: "migrations", database_name: "selected-db" }]);
  writeDeployConfig(root, { D1_DATABASE_NAME: "selected-db" });
  assert.doesNotMatch(readFileSync(output, "utf8"), /database_name/);
});

test("CI overrides the local setup file, while provider settings and secrets stay out of config", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, ".env.setup"), `CLOUDFLARE_ACCOUNT_ID=${valid.CLOUDFLARE_ACCOUNT_ID}\nWORKER_NAME=local-radar\nLLM_ENDPOINT=https://llm.example/v1\nLLM_MODEL=local-model\nLLM_API_KEY=local-secret\n`);
  const { output } = writeDeployConfig(root, {
    WORKER_NAME: "ci-radar", LLM_ENDPOINT: "", LLM_MODEL: "", LLM_API_KEY: "build-secret", CLOUDFLARE_API_TOKEN: "token-secret", OWNER_TOKEN: "owner-fixture",
  });
  const text = readFileSync(output, "utf8");
  const config = JSON.parse(text.slice(text.indexOf("\n") + 1));
  assert.equal(config.name, "ci-radar");
  assert.equal(config.account_id, valid.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.d1_databases[0].database_id, undefined);
  assert.equal(config.vars.LLM_ENDPOINT, undefined);
  assert.equal(config.vars.LLM_MODEL, undefined);
  assert.doesNotMatch(text, /local-secret|build-secret|token-secret|owner-fixture|LLM_API_KEY|CLOUDFLARE_API_TOKEN|OWNER_TOKEN/);
});

test("custom resources keep producers, consumers and dead-letter queues connected", (t) => {
  const { output } = writeDeployConfig(fixture(t), {
    ...valid, EMBEDDING_MODEL: "my-embedding-model", D1_DATABASE_NAME: "custom-db", R2_BUCKET_NAME: "custom-raw",
    POLL_QUEUE_NAME: "custom-poll", LLM_QUEUE_NAME: "custom-llm", DLQ_QUEUE_NAME: "custom-dlq",
    LLM_ENDPOINT: "https://provider.example/v1?api-version=1", LLM_MODEL: 'vendor/model-"quoted"',
  });
  const config = JSON.parse(readFileSync(output, "utf8").split("\n").slice(1).join("\n"));
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_name, undefined);
  assert.equal(config.r2_buckets[0].bucket_name, "custom-raw");
  assert.deepEqual(config.queues.producers.map((q: { queue: string }) => q.queue), ["custom-poll", "custom-llm"]);
  assert.deepEqual(config.queues.consumers.map((q: { queue: string }) => q.queue), ["custom-poll", "custom-llm", "custom-dlq"]);
  assert.equal(config.queues.consumers[0].dead_letter_queue, "custom-dlq");
  assert.equal(config.queues.consumers[1].dead_letter_queue, "custom-dlq");
  assert.equal(config.vars.POLL_QUEUE_NAME, "custom-poll");
  assert.equal(config.vars.LLM_QUEUE_NAME, "custom-llm");
  assert.equal(config.vars.DLQ_QUEUE_NAME, "custom-dlq");
  assert.equal(config.vars.LLM_MODEL, undefined);
  assert.equal(config.vars.LLM_ENDPOINT, undefined);
  assert.equal(config.vars.EMBEDDING_MODEL, undefined);
  assert.equal(config.define, undefined);
  assert.equal(config.assets.run_worker_first, true);
});

test("duplicate queues fail before deployment", (t) => {
  const root = fixture(t);
  for (const override of [
    { POLL_QUEUE_NAME: "same", DLQ_QUEUE_NAME: "same" },
  ]) {
    assert.throws(() => readSetup(root, { ...valid, ...override }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Setup incomplete/);
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
  }
});
