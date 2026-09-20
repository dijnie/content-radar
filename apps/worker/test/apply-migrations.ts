import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: applies only migrations that have not run in this storage yet.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
