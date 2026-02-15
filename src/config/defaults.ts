/**
 * Default configuration values
 */
import { OpenTasksConfigSchema, type OpenTasksConfig } from './schema.js';

/**
 * Default configuration - created by parsing an empty object through the schema
 */
export const DEFAULT_CONFIG: OpenTasksConfig = Object.freeze(
  OpenTasksConfigSchema.parse({}),
) as OpenTasksConfig;

/**
 * Get a frozen copy of the default configuration
 */
export function getDefaults(): OpenTasksConfig {
  return DEFAULT_CONFIG;
}
