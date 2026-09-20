import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests never reach remote resources such as Workers AI.
      remoteBindings: false,
      miniflare: {
        bindings: {
          OWNER_EMAIL: "owner@example.com",
          ACCESS_TEAM_DOMAIN: "https://radar-test.cloudflareaccess.com",
          ACCESS_AUD: "test-audience",
          APP_ORIGIN: "https://radar.example.com",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
