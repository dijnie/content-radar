import { writeDeployConfig } from "./deploy-config.ts";

try {
  writeDeployConfig(undefined, undefined, { databaseCommands: process.argv.includes("--database") });
  console.log("Generated apps/worker/wrangler.jsonc (ignored by Git).");
  console.log("Deployment uses the Worker's D1 binding named DB; no D1_DATABASE_ID build variable is needed.");
  console.log("Setup only writes local configuration; it does not create resources or deploy. See docs/setup.md.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Setup failed");
  process.exitCode = 1;
}
