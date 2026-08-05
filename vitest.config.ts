import { defineConfig } from 'vitest/config';
import path from 'node:path';

// First test harness for the repo (Phase-1 DoD / NFR-012). Unit tests cover the
// pure, high-value logic that has no Supabase dependency: the order state
// machine (lib/orders/stateMachine.ts) and the store hours/slot/bill math
// (lib/store/hours.ts). The `@/*` alias mirrors tsconfig.json so test imports
// match app imports exactly.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // `import 'server-only'` is a Next.js build-time guard with no Node
      // resolution, so anything importing it (the notification engine) can't be
      // unit-tested without a stub. Vitest already runs in a server context.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
