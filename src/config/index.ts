/**
 * Configuration system public API
 */
import { loadConfigFile } from './loader.js';
import { parseEnvConfig } from './env.js';
import { mergeConfigs } from './merge.js';
import type { OpenTasksConfig, PartialOpenTasksConfig } from './schema.js';

// Re-export types and utilities
export { getDefaults, DEFAULT_CONFIG } from './defaults.js';
export { parseEnvConfig } from './env.js';
export { mergeConfigs } from './merge.js';
export { loadConfigFile } from './loader.js';
export { validateConfig, parseConfig } from './schema.js';
export { ConfigParseError, ConfigValidationError } from './errors.js';
export type {
  OpenTasksConfig,
  PartialOpenTasksConfig,
  StorageConfig,
  DaemonConfig,
  ProvidersConfig,
  BeadsProviderConfig,
  ClaudeTasksProviderConfig,
  LoggingConfig,
  LoggingLevel,
  TrackingConfig,
  DeepPartial,
  ValidationResult,
} from './schema.js';

/**
 * Load configuration for a location
 *
 * Configuration is merged in order (later overrides earlier):
 * 1. Built-in defaults
 * 2. Local config file (.opentasks/config.json)
 * 3. Environment variables (OPENTASKS_*)
 *
 * @param location - Location directory (defaults to process.cwd())
 * @returns Complete, validated configuration
 */
export async function loadConfig(location?: string): Promise<OpenTasksConfig> {
  const resolvedLocation = location ?? process.cwd();

  // Load config file (may be null if not present)
  const fileConfig = await loadConfigFile(resolvedLocation);

  // Parse environment variables
  const envConfig = parseEnvConfig();

  // Build config layers to merge
  const layers: PartialOpenTasksConfig[] = [];

  if (fileConfig) {
    layers.push(fileConfig);
  }

  // Env config always applied (may be empty object)
  layers.push(envConfig);

  // Merge all layers (mergeConfigs applies defaults)
  return mergeConfigs(...layers);
}
