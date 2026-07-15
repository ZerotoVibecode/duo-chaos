import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@main': new URL('./src/main', import.meta.url).pathname,
      '@renderer': new URL('./src/renderer/src', import.meta.url).pathname
    }
  },
  test: {
    environment: 'node',
    // The integration suite creates many isolated supervisor Git repositories.
    // Coverage instrumentation and Windows file I/O can push healthy full-suite
    // tests past 30 seconds even though focused runs finish much sooner.
    testTimeout: 90_000,
    setupFiles: ['./tests/setup.ts'],
    // Runtime workspaces and local benchmark harnesses may contain their own
    // *.test.* files. They are private evidence, not part of Duo Chaos's test
    // graph, and must never contaminate public CI or coverage discovery.
    exclude: [
      'tests/e2e/**',
      'node_modules/**',
      'out/**',
      'release/**',
      'coverage/**',
      'test-results/**',
      'workspaces/**',
      'runs/**',
      '.duo/**',
      '.codex/**'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['src/main/index.ts', 'src/main/ipc.ts', 'src/shared/electron-api.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    }
  }
})
