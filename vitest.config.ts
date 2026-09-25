import { defineConfig } from 'vitest/config';
import path from 'node:path';

// First test harness for the repo (Phase-1 DoD / NFR-012). Unit tests cover the
// pure, high-value logic that has no Supabase dependency: the order state
// machine (lib/orders/stateMachine.ts) and the store hours/slot/bill math
// (lib/store/hours.ts). The `@/*` alias mirrors tsconfig.json so test imports
// match app imports exactly.
export default defineConfig({
  // tsconfig.json sets "jsx": "preserve" (Next's own SWC/babel pipeline does
  // the actual JSX transform at build time), so vitest's esbuild transform
  // needs its own jsx settings here or a .tsx/.ts file that returns JSX (e.g.
  // a page.tsx tested directly, PIN-2's staffLoginPinRedirect.test.ts) fails
  // at runtime with "React is not defined" — automatic/react matches what
  // Next actually does (the automatic JSX runtime, no React import needed).
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // `import 'server-only'` is a Next.js build-time guard with no Node
      // resolution, so anything importing it (the notification engine) can't be
      // unit-tested without a stub. Vitest already runs in a server context.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
      // `desktop/src/printers/store.ts` imports Electron's `app` only for
      // `app.getPath('userData')` — stubbed so its pure validation logic is
      // unit-testable without a real Electron main process (see the stub).
      electron: path.resolve(__dirname, 'tests/stubs/electron.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
