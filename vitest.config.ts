import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit tests only — no Docker/SSH required
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
    // pwsh round-trip tests spawn real processes — can be slow on CI
    testTimeout: 15000,
  },
});
