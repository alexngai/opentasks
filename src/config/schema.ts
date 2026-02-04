/**
 * Configuration schema with Zod validation
 */
import { z } from 'zod'

// ============================================================================
// Storage Configuration
// ============================================================================

const StorageConfigSchemaInner = z.object({
  /** JSONL file path (relative to .opentasks/) */
  jsonlPath: z.string().default('graph.jsonl'),

  /** SQLite database path (relative to .opentasks/) */
  sqlitePath: z.string().default('cache.db'),

  /** Auto-compact JSONL when ratio exceeds threshold */
  autoCompactRatio: z.number().min(1, 'autoCompactRatio must be >= 1').default(2.0),
})

export const StorageConfigSchema = z
  .object({
    jsonlPath: z.string().optional(),
    sqlitePath: z.string().optional(),
    autoCompactRatio: z.number().min(1, 'autoCompactRatio must be >= 1').optional(),
  })
  .default({})
  .transform((val) => StorageConfigSchemaInner.parse(val))

export type StorageConfig = z.infer<typeof StorageConfigSchema>

// ============================================================================
// Daemon Configuration
// ============================================================================

const DaemonConfigSchemaInner = z.object({
  /** Socket path (relative to .opentasks/) */
  socketPath: z.string().default('daemon.sock'),

  /** Auto-start daemon on first operation */
  autoStart: z.boolean().default(true),

  /** Flush interval (ms) */
  flushInterval: z.number().min(100, 'flushInterval must be >= 100ms').default(1000),
})

export const DaemonConfigSchema = z
  .object({
    socketPath: z.string().optional(),
    autoStart: z.boolean().optional(),
    flushInterval: z.number().min(100, 'flushInterval must be >= 100ms').optional(),
  })
  .default({})
  .transform((val) => DaemonConfigSchemaInner.parse(val))

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>

// ============================================================================
// Provider Configuration
// ============================================================================

const BeadsProviderConfigSchemaInner = z.object({
  /** Enable beads provider (auto-detects executable) */
  enabled: z.boolean().default(true),

  /** Path to bd executable */
  executable: z.string().default('bd'),

  /** Command timeout (ms) */
  timeout: z.number().min(1000, 'timeout must be >= 1000ms').default(30000),
})

export const BeadsProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    executable: z.string().optional(),
    timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
  })
  .default({})
  .transform((val) => BeadsProviderConfigSchemaInner.parse(val))

export type BeadsProviderConfig = z.infer<typeof BeadsProviderConfigSchema>

const ClaudeTasksProviderConfigSchemaInner = z.object({
  /** Enable Claude Tasks provider */
  enabled: z.boolean().default(true),
})

export const ClaudeTasksProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .default({})
  .transform((val) => ClaudeTasksProviderConfigSchemaInner.parse(val))

export type ClaudeTasksProviderConfig = z.infer<typeof ClaudeTasksProviderConfigSchema>

const ProvidersConfigSchemaInner = z.object({
  beads: BeadsProviderConfigSchema,
  claudeTasks: ClaudeTasksProviderConfigSchema,
})

export const ProvidersConfigSchema = z
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
  .default({})
  .transform((val) => ProvidersConfigSchemaInner.parse(val))

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>

// ============================================================================
// Logging Configuration
// ============================================================================

export const LoggingLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])

export type LoggingLevel = z.infer<typeof LoggingLevelSchema>

const LoggingConfigSchemaInner = z.object({
  /** Log level */
  level: LoggingLevelSchema.default('info'),

  /** Log file path (relative to .opentasks/, null = no file) */
  file: z.string().nullable().default(null),
})

export const LoggingConfigSchema = z
  .object({
    level: LoggingLevelSchema.optional(),
    file: z.string().nullable().optional(),
  })
  .default({})
  .transform((val) => LoggingConfigSchemaInner.parse(val))

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>

// ============================================================================
// Root Configuration Schema
// ============================================================================

const OpenTasksConfigSchemaInner = z.object({
  storage: StorageConfigSchema,
  daemon: DaemonConfigSchema,
  providers: ProvidersConfigSchema,
  logging: LoggingConfigSchema,
})

export const OpenTasksConfigSchema = z
  .object({
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
  .default({})
  .transform((val) => OpenTasksConfigSchemaInner.parse(val))

export type OpenTasksConfig = z.infer<typeof OpenTasksConfigSchema>

// ============================================================================
// Partial Configuration Type (for merging)
// ============================================================================

/** Deep partial type for config merging */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

export type PartialOpenTasksConfig = DeepPartial<OpenTasksConfig>

// ============================================================================
// Validation Utilities
// ============================================================================

export interface ValidationResult {
  success: boolean
  data?: OpenTasksConfig
  errors?: Array<{
    path: string
    message: string
  }>
}

/**
 * Validate a configuration object
 */
export function validateConfig(config: unknown): ValidationResult {
  const result = OpenTasksConfigSchema.safeParse(config)

  if (result.success) {
    return {
      success: true,
      data: result.data,
    }
  }

  return {
    success: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  }
}

/**
 * Parse and validate a configuration, throwing on error
 */
export function parseConfig(config: unknown): OpenTasksConfig {
  return OpenTasksConfigSchema.parse(config)
}
