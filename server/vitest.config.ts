import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    env: { NODE_ENV: 'test', AI_PROVIDER: 'rules', LOG_LEVEL: 'silent', DISABLE_RATE_LIMIT: 'true' },
  },
});
