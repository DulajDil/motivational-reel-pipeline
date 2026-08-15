import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mrp/shared': resolvePath('./services/shared/src/index.ts'),
      '@mrp/providers': resolvePath('./services/providers/src/index.ts'),
      '@mrp/handlers': resolvePath('./services/handlers/src/index.ts'),
      '@mrp/renderer': resolvePath('./renderer/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Unit + contract + integration tests must never need AWS credentials.
    env: {
      ENVIRONMENT: 'test',
      AWS_REGION: 'ap-southeast-2',
      PUBLISH_MODE: 'dry_run',
      PROVIDER_MODE: 'mock',
    },
    coverage: {
      provider: 'v8',
      include: ['services/**/src/**/*.ts', 'renderer/src/**/*.ts'],
    },
  },
});
