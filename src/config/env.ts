/**
 * Environment variable parser for config
 */
import type { PartialOpenTasksConfig, LoggingLevel } from './schema.js';

/**
 * Mapping of environment variable names to config paths and types
 */
interface EnvMapping {
  envVar: string;
  path: string[];
  type: 'string' | 'number' | 'boolean' | 'nullable-string';
}

const ENV_MAPPINGS: EnvMapping[] = [
  // Storage
  { envVar: 'OPENTASKS_STORAGE_JSONL_PATH', path: ['storage', 'jsonlPath'], type: 'string' },
  { envVar: 'OPENTASKS_STORAGE_SQLITE_PATH', path: ['storage', 'sqlitePath'], type: 'string' },
  {
    envVar: 'OPENTASKS_STORAGE_AUTO_COMPACT_RATIO',
    path: ['storage', 'autoCompactRatio'],
    type: 'number',
  },

  // Daemon
  { envVar: 'OPENTASKS_DAEMON_SOCKET_PATH', path: ['daemon', 'socketPath'], type: 'string' },
  { envVar: 'OPENTASKS_DAEMON_AUTO_START', path: ['daemon', 'autoStart'], type: 'boolean' },
  {
    envVar: 'OPENTASKS_DAEMON_FLUSH_INTERVAL',
    path: ['daemon', 'flushInterval'],
    type: 'number',
  },

  // Providers - Beads
  {
    envVar: 'OPENTASKS_PROVIDERS_BEADS_ENABLED',
    path: ['providers', 'beads', 'enabled'],
    type: 'boolean',
  },
  {
    envVar: 'OPENTASKS_PROVIDERS_BEADS_EXECUTABLE',
    path: ['providers', 'beads', 'executable'],
    type: 'string',
  },
  {
    envVar: 'OPENTASKS_PROVIDERS_BEADS_TIMEOUT',
    path: ['providers', 'beads', 'timeout'],
    type: 'number',
  },

  // Providers - Claude Tasks
  {
    envVar: 'OPENTASKS_PROVIDERS_CLAUDE_TASKS_ENABLED',
    path: ['providers', 'claudeTasks', 'enabled'],
    type: 'boolean',
  },

  // Logging
  { envVar: 'OPENTASKS_LOGGING_LEVEL', path: ['logging', 'level'], type: 'string' },
  { envVar: 'OPENTASKS_LOGGING_FILE', path: ['logging', 'file'], type: 'nullable-string' },
];

/**
 * Parse a boolean value from an environment variable
 */
function parseBoolean(value: string): boolean {
  const lower = value.toLowerCase();
  return lower === 'true' || lower === '1';
}

/**
 * Parse a number value from an environment variable
 */
function parseNumber(value: string): number {
  const num = parseFloat(value);
  if (isNaN(num)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return num;
}

/**
 * Parse a nullable string value from an environment variable
 */
function parseNullableString(value: string): string | null {
  if (value === '' || value.toLowerCase() === 'null') {
    return null;
  }
  return value;
}

/**
 * Set a nested value in an object
 */
function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!(key in current)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

/**
 * Parse environment variables into a partial config object
 * @param env - Environment variables (defaults to process.env)
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
): PartialOpenTasksConfig {
  const config: Record<string, unknown> = {};

  for (const mapping of ENV_MAPPINGS) {
    const value = env[mapping.envVar];
    if (value === undefined) {
      continue;
    }

    try {
      let parsedValue: unknown;
      switch (mapping.type) {
        case 'string':
          parsedValue = value;
          break;
        case 'number':
          parsedValue = parseNumber(value);
          break;
        case 'boolean':
          parsedValue = parseBoolean(value);
          break;
        case 'nullable-string':
          parsedValue = parseNullableString(value);
          break;
      }
      setNestedValue(config, mapping.path, parsedValue);
    } catch {
      // Skip invalid values silently
      continue;
    }
  }

  return config as PartialOpenTasksConfig;
}

/**
 * Valid logging levels for type checking
 */
const VALID_LOGGING_LEVELS: LoggingLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Check if a value is a valid logging level
 */
export function isValidLoggingLevel(value: string): value is LoggingLevel {
  return VALID_LOGGING_LEVELS.includes(value as LoggingLevel);
}
