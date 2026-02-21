import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests — require Docker running + SSH test container
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 30000,
    // Run test files sequentially — they share Docker containers and ports
    fileParallelism: false,
  },
});
