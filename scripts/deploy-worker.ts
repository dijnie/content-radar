import { execFileSync } from "node:child_process";
import { projectRoot, writeDeployConfig } from "./deploy-config.ts";

const { output, provisioned } = writeDeployConfig();
const wrangler = (...args: string[]) => ["wrangler", ...args, "--config", output];
const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: projectRoot, stdio: "inherit" });

if (provisioned) {
  // The template wizard has written the chosen database ID to the cloned repository.
  run("npx", wrangler("d1", "time-travel", "info", "DB"));
  run("npx", wrangler("d1", "migrations", "apply", "DB", "--remote"));
  const result = execFileSync("npx", wrangler("d1", "execute", "DB", "--remote", "--json", "--command",
    "SELECT EXISTS(SELECT 1 FROM sources) AS seeded"), { cwd: projectRoot, encoding: "utf8" });
  const seeded = JSON.parse(result)[0]?.results?.[0]?.seeded;
  if (seeded !== 0 && seeded !== 1) throw new Error("Could not check whether the D1 source catalog is initialized.");
  if (seeded === 0) run("npm", ["run", "config:sync", "--", "--remote"]);
}
run("npx", wrangler("deploy"));
