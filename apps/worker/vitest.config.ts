import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.template.json" },
        // Tests use local bindings.
        remoteBindings: false,
        miniflare: {
          bindings: {
            LLM_ENDPOINT: "https://llm.example/v1",
            LLM_MODEL: "deepseek-flash",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
