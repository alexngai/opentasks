/**
 * Config file loader
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'
import { LoggingLevelSchema, type PartialOpenTasksConfig } from './schema'
import { ConfigParseError, ConfigValidationError } from './errors'

/**
 * Partial schema for validating config files (all fields optional)
 */
const PartialConfigSchema = z.object({
  storage: z
    .object({
      jsonlPath: z.string().optional(),
      sqlitePath: z.string().optional(),
      autoCompactRatio: z.number().min(1, 'autoCompactRatio must be >= 1').optional(),
    })
    .optional(),
  daemon: z
    .object({
      socketPath: z.string().optional(),
      autoStart: z.boolean().optional(),
      flushInterval: z.number().min(100, 'flushInterval must be >= 100ms').optional(),
    })
    .optional(),
  providers: z
    .object({
      beads: z
        .object({
          enabled: z.boolean().optional(),
          executable: z.string().optional(),
          timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
        })
        .optional(),
      claudeTasks: z
        .object({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  logging: z
    .object({
      level: LoggingLevelSchema.optional(),
      file: z.string().nullable().optional(),
    })
    .optional(),
})

/**
 * Load and parse a config file from a location
 * @param location - The location directory (e.g., project root)
 * @returns Partial config or null if file doesn't exist
 */
export async function loadConfigFile(location: string): Promise<PartialOpenTasksConfig | null> {
  const configPath = path.join(location, '.opentasks', 'config.json')

  // Check if file exists
  try {
    await fs.access(configPath)
  } catch {
    return null
  }

  // Read file
  let content: string
  try {
    content = await fs.readFile(configPath, 'utf-8')
  } catch (err) {
    throw new ConfigParseError(configPath, err as Error)
  }

  // Parse JSON
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    throw new ConfigParseError(configPath, err as Error)
  }

  // Validate against partial schema
  const result = PartialConfigSchema.safeParse(json)
  if (!result.success) {
    throw new ConfigValidationError(configPath, result.error.issues)
  }

  return result.data as PartialOpenTasksConfig
}
