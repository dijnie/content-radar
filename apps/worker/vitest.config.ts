import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests never reach remote resources such as Workers AI.
        remoteBindings: false,
        miniflare: {
          bindings: {
            LLM_ENDPOINT: "https://llm.example/v1",
            LLM_MODEL: "deepseek-flash",
            OWNER_EMAIL: "owner@example.com",
            ACCESS_TEAM_DOMAIN: "https://radar-test.cloudflareaccess.com",
            ACCESS_AUD: "test-audience",
            APP_ORIGIN: "https://radar.example.com",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
