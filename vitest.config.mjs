import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // These suites launch real subprocesses, servers and FULL-sync SQLite stores.
  // Unbounded worker fanout caused machine contention and false lifecycle timeouts.
  // KODO_HOME keeps global instructions and cross-process write locks out of the user's home.
  // FULL-sync storage and real child startup can exceed Vitest's default 5s on
  // a busy workstation. Runtime deadlines remain asserted inside the tests.
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], maxWorkers: 1, testTimeout: 30_000, env: { KODO_HOME: path.join(os.tmpdir(), `kodo-test-home-${process.pid}`), KODO_TEST_RETRY_DELAY_MS: '0' } },
});
