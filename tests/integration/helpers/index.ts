/**
 * Integration Test Helpers
 *
 * Shared utilities for integration tests.
 */

// Test flags
export {
  SLOW_TESTS,
  AGENT_TESTS,
  SLOW_SKIP_MESSAGE,
  AGENT_SKIP_MESSAGE,
} from './flags.js'

// Process utilities
export {
  spawnDaemon,
  waitForExit,
  killProcess,
  collectStdout,
  collectStderr,
  commandExists,
  runCommand,
  type SpawnDaemonOptions,
} from './process.js'

// Wait utilities
export {
  waitFor,
  waitForFile,
  waitForFileModified,
  waitForSocket,
  waitForSocketRemoved,
  sleep,
  retry,
  type WaitOptions,
} from './wait.js'

// Temp directory utilities
export {
  createTempDir,
  removeTempDir,
  withTempDir,
  uniqueSocketPath,
  uniqueFilePath,
  type TempDirContext,
} from './temp.js'
