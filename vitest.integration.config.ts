import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 60_000,
    environment: 'node',
  },
});
