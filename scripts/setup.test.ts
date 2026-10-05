import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { projectRoot, readSetup, writeDeployConfig } from "./deploy-config.ts";

const valid = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  D1_DATABASE_ID: "12345678-1234-4234-8234-123456789abc",
};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "radar-setup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "apps/worker"), { recursive: true });
  cpSync(path.join(projectRoot, "apps/worker/wrangler.template.json"), path.join(root, "apps/worker/wrangler.template.json"));
  return root;
}

test("setup refuses missing or placeholder IDs without replacing a working config", (t) => {
  const root = fixture(t);
  const output = path.join(root, "apps/worker/wrangler.jsonc");
  writeFileSync(output, "existing configuration");
  for (const env of [{}, { ...valid, D1_DATABASE_ID: "" }, { ...valid, D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000" }]) {
    assert.throws(() => writeDeployConfig(root, env), /D1_DATABASE_ID/);
    assert.equal(readFileSync(output, "utf8"), "existing configuration");
  }
});

test("CI overrides the local setup file, including explicit blanks; secrets stay out of config", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, ".env.setup"), `CLOUDFLARE_ACCOUNT_ID=${valid.CLOUDFLARE_ACCOUNT_ID}\nD1_DATABASE_ID=${valid.D1_DATABASE_ID}\nWORKER_NAME=local-radar\nLLM_ENDPOINT=https://llm.example/v1\nLLM_MODEL=local-model\nLLM_API_KEY=local-secret\n`);
  const { output, llmEnabled } = writeDeployConfig(root, {
    WORKER_NAME: "ci-radar", LLM_ENDPOINT: "", LLM_MODEL: "", LLM_API_KEY: "build-secret", CLOUDFLARE_API_TOKEN: "token-secret",
  });
  const text = readFileSync(output, "utf8");
  const config = JSON.parse(text.slice(text.indexOf("\n") + 1));
  assert.equal(config.name, "ci-radar");
  assert.equal(config.account_id, valid.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.d1_databases[0].database_id, valid.D1_DATABASE_ID);
  assert.equal(config.vars.LLM_ENDPOINT, "");
  assert.equal(config.vars.LLM_MODEL, "");
  assert.equal(llmEnabled, false);
  assert.doesNotMatch(text, /local-secret|build-secret|token-secret|LLM_API_KEY|CLOUDFLARE_API_TOKEN/);
});

test("custom resources keep producers, consumers and dead-letter queues connected", (t) => {
  const { output, llmEnabled } = writeDeployConfig(fixture(t), {
    ...valid, D1_DATABASE_NAME: "custom-db", R2_BUCKET_NAME: "custom-raw",
    POLL_QUEUE_NAME: "custom-poll", LLM_QUEUE_NAME: "custom-llm", DLQ_QUEUE_NAME: "custom-dlq",
    LLM_ENDPOINT: "https://provider.example/v1?api-version=1", LLM_MODEL: 'vendor/model-"quoted"',
  });
  const config = JSON.parse(readFileSync(output, "utf8").split("\n").slice(1).join("\n"));
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_name, "custom-db");
  assert.equal(config.r2_buckets[0].bucket_name, "custom-raw");
  assert.deepEqual(config.queues.producers.map((q: { queue: string }) => q.queue), ["custom-poll", "custom-llm"]);
  assert.deepEqual(config.queues.consumers.map((q: { queue: string }) => q.queue), ["custom-poll", "custom-llm", "custom-dlq"]);
  assert.equal(config.queues.consumers[0].dead_letter_queue, "custom-dlq");
  assert.equal(config.queues.consumers[1].dead_letter_queue, "custom-dlq");
  assert.equal(config.vars.POLL_QUEUE_NAME, "custom-poll");
  assert.equal(config.vars.LLM_QUEUE_NAME, "custom-llm");
  assert.equal(config.vars.DLQ_QUEUE_NAME, "custom-dlq");
  assert.equal(config.vars.LLM_MODEL, 'vendor/model-"quoted"');
  assert.equal(config.vars.LLM_ENDPOINT, "https://provider.example/v1?api-version=1");
  assert.equal(config.define.__DEV_AUTH_BYPASS__, "false");
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(llmEnabled, true);
});

test("invalid provider configuration and duplicate queues fail before deployment", (t) => {
  const root = fixture(t);
  for (const override of [
    { LLM_MODEL: "model" },
    { LLM_ENDPOINT: "https://provider.example/v1" },
    { LLM_ENDPOINT: "https://user:private-value@provider.example/v1", LLM_MODEL: "model" },
    { LLM_ENDPOINT: "https://provider.example/v1#private-value", LLM_MODEL: "model" },
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
