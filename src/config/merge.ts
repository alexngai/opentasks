/**
 * Config merger - deep merges config layers
 */
import { parseConfig, type OpenTasksConfig, type PartialOpenTasksConfig } from './schema.js'

/**
 * Check if a value is a plain object (not null, not array)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep merge two objects
 * - Later values override earlier values
 * - Explicit null values are preserved
 * - undefined values are skipped
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target }

  for (const key in source) {
    const sourceValue = source[key]

    // Skip undefined values
    if (sourceValue === undefined) {
      continue
    }

    // If both are plain objects, merge recursively
    if (isPlainObject(sourceValue) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, sourceValue)
    } else {
      // Otherwise, override (including null values)
      result[key] = sourceValue
    }
  }

  return result
}

/**
 * Merge multiple partial configs into a complete config
 * Later configs override earlier ones
 * @param configs - Partial configs to merge (in order)
 * @returns Complete, validated OpenTasksConfig
 */
export function mergeConfigs(...configs: PartialOpenTasksConfig[]): OpenTasksConfig {
  // Start with empty object
  let merged: Record<string, unknown> = {}

  // Merge each config in order
  for (const config of configs) {
    if (config) {
      merged = deepMerge(merged, config as Record<string, unknown>)
    }
  }

  // Parse through schema to apply defaults and validate
  return parseConfig(merged)
}
