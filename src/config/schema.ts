/**
 * Configuration schema with Zod validation
 *
 * Phase 2 additions: location identity, connections, role, redirects
 */
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

// ============================================================================
// Location Identity (Phase 2)
// ============================================================================

const LocationConfigSchemaInner = z.object({
  /** 8-char base36 deterministic hash */
  hash: z.string(),
  /** UUID v4 uniqueness guarantee */
  uuid: z.string().uuid(),
  /** Human-readable name */
  name: z.string(),
})

export const LocationConfigSchema = z
  .object({
    hash: z.string().optional(),
    uuid: z.string().uuid().optional(),
    name: z.string().optional(),
  })
  .optional()
  .transform((val) => {
    if (!val || !val.hash) return undefined
    return LocationConfigSchemaInner.parse({
      hash: val.hash,
      uuid: val.uuid ?? randomUUID(),
      name: val.name ?? '',
    })
  })

export type LocationConfig = z.infer<typeof LocationConfigSchemaInner>

// ============================================================================
// Connection Configuration (Phase 2)
// ============================================================================

export const ConnectionRoleSchema = z.enum(['peer', 'parent', 'child'])

export const ConnectionSchema = z.object({
  /** Location hash of the target */
  hash: z.string(),
  /** Path to target .opentasks directory */
  path: z.string(),
  /** Relationship role */
  role: ConnectionRoleSchema.default('peer'),
  /** Human-readable name */
  name: z.string().default(''),
})

export type ConnectionConfig = z.infer<typeof ConnectionSchema>

// ============================================================================
// Redirect Rules (Phase 2)
// ============================================================================

export const RedirectOperationSchema = z.enum(['read', 'write'])

export const RedirectRuleSchema = z.object({
  /** Operations this rule applies to */
  operations: z.array(RedirectOperationSchema),
  /** Glob pattern for node IDs */
  pattern: z.string().default('*'),
  /** Target location URI or hash */
  target: z.string(),
  /** Priority (lower = higher priority) */
  priority: z.number().default(100),
  /** Fallback behavior */
  fallback: z.enum(['local', 'error']).default('error'),
})

export type RedirectRuleConfig = z.infer<typeof RedirectRuleSchema>

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

const SudocodeProviderConfigSchemaInner = z.object({
  /** Enable Sudocode provider (auto-detects executable) */
  enabled: z.boolean().default(true),

  /** Path to sudocode executable */
  executable: z.string().default('sudocode'),

  /** Command timeout (ms) */
  timeout: z.number().min(1000, 'timeout must be >= 1000ms').default(30000),
})

export const SudocodeProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    executable: z.string().optional(),
    timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
  })
  .default({})
  .transform((val) => SudocodeProviderConfigSchemaInner.parse(val))

export type SudocodeProviderConfig = z.infer<typeof SudocodeProviderConfigSchema>

const ProvidersConfigSchemaInner = z.object({
  beads: BeadsProviderConfigSchema,
  claudeTasks: ClaudeTasksProviderConfigSchema,
  sudocode: SudocodeProviderConfigSchema,
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
    sudocode: z
      .object({
        enabled: z.boolean().optional(),
        executable: z.string().optional(),
        timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
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
  version: z.string().default('1.0'),
  storage: StorageConfigSchema,
  daemon: DaemonConfigSchema,
  providers: ProvidersConfigSchema,
  logging: LoggingConfigSchema,
  /** Location identity (Phase 2) */
  location: LocationConfigSchema,
  /** Explicit connections to other locations (Phase 2) */
  connections: z.array(ConnectionSchema).default([]),
  /** Location role (Phase 2) */
  role: z.enum(['manager', 'worker', 'standalone']).default('standalone'),
  /** Redirect rules (Phase 2) */
  redirects: z.array(RedirectRuleSchema).default([]),
  /** Default provider for CRUD operations ('native' = local GraphStore) */
  defaultProvider: z.string().default('native'),
})

export const OpenTasksConfigSchema = z
  .object({
    version: z.string().optional(),
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
        sudocode: z
          .object({
            enabled: z.boolean().optional(),
            executable: z.string().optional(),
            timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
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
    location: z
      .object({
        hash: z.string().optional(),
        uuid: z.string().uuid().optional(),
        name: z.string().optional(),
      })
      .optional(),
    connections: z.array(
      z.object({
        hash: z.string(),
        path: z.string(),
        role: ConnectionRoleSchema.optional(),
        name: z.string().optional(),
      })
    ).optional(),
    role: z.enum(['manager', 'worker', 'standalone']).optional(),
    redirects: z.array(
      z.object({
        operations: z.array(RedirectOperationSchema),
        pattern: z.string().optional(),
        target: z.string(),
        priority: z.number().optional(),
        fallback: z.enum(['local', 'error']).optional(),
      })
    ).optional(),
    defaultProvider: z.string().optional(),
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
