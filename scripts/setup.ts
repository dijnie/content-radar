import { writeDeployConfig } from "./deploy-config.ts";

try {
  const { llmEnabled } = writeDeployConfig();
  console.log("Generated apps/worker/wrangler.jsonc (ignored by Git).");
  console.log(`LLM processing: ${llmEnabled ? "enabled — configure the LLM_API_KEY runtime secret" : "paused — LLM_ENDPOINT and LLM_MODEL are empty"}.`);
  console.log("Setup only writes local configuration; it does not create resources or deploy. See docs/setup.md.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Setup failed");
  process.exitCode = 1;
}
