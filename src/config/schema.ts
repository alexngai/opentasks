/**
 * Configuration schema with Zod validation
 *
 * Phase 2 additions: location identity, connections, role, redirects
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

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
});

export const LocationConfigSchema = z
  .object({
    hash: z.string().optional(),
    uuid: z.string().uuid().optional(),
    name: z.string().optional(),
  })
  .optional()
  .transform((val) => {
    if (!val || !val.hash) return undefined;
    return LocationConfigSchemaInner.parse({
      hash: val.hash,
      uuid: val.uuid ?? randomUUID(),
      name: val.name ?? '',
    });
  });

export type LocationConfig = z.infer<typeof LocationConfigSchemaInner>;

// ============================================================================
// Connection Configuration (Phase 2)
// ============================================================================

export const ConnectionRoleSchema = z.enum(['peer', 'parent', 'child']);

export const ConnectionSchema = z.object({
  /** Location hash of the target */
  hash: z.string(),
  /** Path to target .opentasks directory */
  path: z.string(),
  /** Relationship role */
  role: ConnectionRoleSchema.default('peer'),
  /** Human-readable name */
  name: z.string().default(''),
});

export type ConnectionConfig = z.infer<typeof ConnectionSchema>;

// ============================================================================
// Redirect Rules (Phase 2)
// ============================================================================

export const RedirectOperationSchema = z.enum(['read', 'write']);

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
});

export type RedirectRuleConfig = z.infer<typeof RedirectRuleSchema>;

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
});

export const StorageConfigSchema = z
  .object({
    jsonlPath: z.string().optional(),
    sqlitePath: z.string().optional(),
    autoCompactRatio: z.number().min(1, 'autoCompactRatio must be >= 1').optional(),
  })
  .default({})
  .transform((val) => StorageConfigSchemaInner.parse(val));

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

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
});

export const DaemonConfigSchema = z
  .object({
    socketPath: z.string().optional(),
    autoStart: z.boolean().optional(),
    flushInterval: z.number().min(100, 'flushInterval must be >= 100ms').optional(),
  })
  .default({})
  .transform((val) => DaemonConfigSchemaInner.parse(val));

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

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
});

export const BeadsProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    executable: z.string().optional(),
    timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
  })
  .default({})
  .transform((val) => BeadsProviderConfigSchemaInner.parse(val));

export type BeadsProviderConfig = z.infer<typeof BeadsProviderConfigSchema>;

const ClaudeTasksProviderConfigSchemaInner = z.object({
  /** Enable Claude Tasks provider */
  enabled: z.boolean().default(true),
  /** Optional filesystem directory for persistent task storage */
  tasksDir: z.string().optional(),
});

export const ClaudeTasksProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    tasksDir: z.string().optional(),
  })
  .default({})
  .transform((val) => ClaudeTasksProviderConfigSchemaInner.parse(val));

export type ClaudeTasksProviderConfig = z.infer<typeof ClaudeTasksProviderConfigSchema>;

const SessionlogProviderConfigSchemaInner = z.object({
  /** Enable sessionlog provider and auto-linking */
  enabled: z.boolean().default(true),

  /** Optional path to sessionlog CLI executable (e.g. 'entire' or '/usr/local/bin/entire').
   *  When set, the Go CLI is preferred if available, with fallback to the built-in TS store.
   *  When omitted, the built-in TS store is used directly. */
  executable: z.string().optional(),

  /** Command timeout (ms) */
  timeout: z.number().min(1000, 'timeout must be >= 1000ms').default(30000),

  /** Enable automatic session ↔ task linking */
  autoLink: z.boolean().default(true),

  /** Minimum confidence for auto-linking */
  autoLinkMinConfidence: z.enum(['high', 'medium', 'low']).default('medium'),

  /** Session directory name under .git/ (default: 'sessionlog-sessions') */
  sessionDirName: z.string().default('sessionlog-sessions'),

  /** Git branch for committed checkpoints (default: 'sessionlog/checkpoints/v1') */
  checkpointsBranch: z.string().default('sessionlog/checkpoints/v1'),

  /** Prefix for shadow branches (default: 'sessionlog/') */
  shadowBranchPrefix: z.string().default('sessionlog/'),
});

export const SessionlogProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    executable: z.string().optional(),
    timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
    autoLink: z.boolean().optional(),
    autoLinkMinConfidence: z.enum(['high', 'medium', 'low']).optional(),
    sessionDirName: z.string().optional(),
    checkpointsBranch: z.string().optional(),
    shadowBranchPrefix: z.string().optional(),
  })
  .default({})
  .transform((val) => SessionlogProviderConfigSchemaInner.parse(val));

export type SessionlogProviderConfig = z.infer<typeof SessionlogProviderConfigSchema>;

const SudocodeProviderConfigSchemaInner = z.object({
  /** Enable Sudocode provider (auto-detects executable) */
  enabled: z.boolean().default(true),

  /** Path to sudocode executable */
  executable: z.string().default('sudocode'),

  /** Command timeout (ms) */
  timeout: z.number().min(1000, 'timeout must be >= 1000ms').default(30000),
});

export const SudocodeProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    executable: z.string().optional(),
    timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
  })
  .default({})
  .transform((val) => SudocodeProviderConfigSchemaInner.parse(val));

export type SudocodeProviderConfig = z.infer<typeof SudocodeProviderConfigSchema>;

const GlobalProviderConfigSchemaInner = z.object({
  /** Enable global provider for federation with ~/.opentasks */
  enabled: z.boolean().default(true),

  /** Path to the global .opentasks directory (empty = ~/.opentasks) */
  path: z.string().default(''),

  /** Connection timeout for IPC to global daemon (ms) */
  timeout: z.number().min(1000, 'timeout must be >= 1000ms').default(10000),

  /** TTL for cached data from global store (ms) */
  cacheTTL: z.number().min(0, 'cacheTTL must be >= 0').default(300000),
});

export const GlobalProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
    timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
    cacheTTL: z.number().min(0, 'cacheTTL must be >= 0').optional(),
  })
  .default({})
  .transform((val) => GlobalProviderConfigSchemaInner.parse(val));

export type GlobalProviderConfig = z.infer<typeof GlobalProviderConfigSchema>;

const MAPProviderConfigSchemaInner = z.object({
  /** Enable MAP provider for cross-system task coordination */
  enabled: z.boolean().default(false),

  /**
   * MAP server WebSocket URL (e.g., 'ws://localhost:8080').
   * Required when enabled. If empty and enabled, provider creation is skipped.
   */
  server: z.string().default(''),

  /**
   * System identifier for this MAP connection.
   * Used in URIs: map://{systemId}/{taskId}
   */
  systemId: z.string().default('default'),

  /** Request timeout (ms) */
  timeout: z.number().min(1000, 'timeout must be >= 1000ms').default(30000),

  /**
   * Agent name for the MAP connection.
   * Defaults to 'opentasks-daemon'.
   */
  agentName: z.string().default('opentasks-daemon'),

  /**
   * MAP scope to join (e.g., 'swarm:team-name').
   * If empty, no scope is joined.
   */
  scope: z.string().default(''),

  /**
   * Enable the outbound event bridge.
   * When true, local graph changes are emitted as MAP task events.
   * Defaults to true (active when the MAP provider is enabled).
   */
  eventBridge: z.boolean().default(true),
});

export const MAPProviderConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    server: z.string().optional(),
    systemId: z.string().optional(),
    timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
    agentName: z.string().optional(),
    scope: z.string().optional(),
    eventBridge: z.boolean().optional(),
  })
  .default({})
  .transform((val) => MAPProviderConfigSchemaInner.parse(val));

export type MAPProviderConfig = z.infer<typeof MAPProviderConfigSchema>;

const ProvidersConfigSchemaInner = z.object({
  beads: BeadsProviderConfigSchema,
  claudeTasks: ClaudeTasksProviderConfigSchema,
  sudocode: SudocodeProviderConfigSchema,
  sessionlog: SessionlogProviderConfigSchema,
  global: GlobalProviderConfigSchema,
  map: MAPProviderConfigSchema,
});

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
        tasksDir: z.string().optional(),
      })
      .optional(),
    sudocode: z
      .object({
        enabled: z.boolean().optional(),
        executable: z.string().optional(),
        timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
      })
      .optional(),
    sessionlog: z
      .object({
        enabled: z.boolean().optional(),
        executable: z.string().optional(),
        timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
        autoLink: z.boolean().optional(),
        autoLinkMinConfidence: z.enum(['high', 'medium', 'low']).optional(),
        sessionDirName: z.string().optional(),
        checkpointsBranch: z.string().optional(),
        shadowBranchPrefix: z.string().optional(),
      })
      .optional(),
    /** @deprecated Use `sessionlog` instead. Accepted for backwards compatibility. */
    entire: z
      .object({
        enabled: z.boolean().optional(),
        executable: z.string().optional(),
        timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
        autoLink: z.boolean().optional(),
        autoLinkMinConfidence: z.enum(['high', 'medium', 'low']).optional(),
        sessionDirName: z.string().optional(),
        checkpointsBranch: z.string().optional(),
        shadowBranchPrefix: z.string().optional(),
      })
      .optional(),
    global: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
        cacheTTL: z.number().min(0, 'cacheTTL must be >= 0').optional(),
      })
      .optional(),
    map: z
      .object({
        enabled: z.boolean().optional(),
        systemId: z.string().optional(),
        timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
      })
      .optional(),
  })
  .default({})
  .transform((val) => {
    // Backwards compat: providers.entire -> providers.sessionlog
    const { entire, ...rest } = val;
    const merged = { ...rest };
    if (entire && !rest.sessionlog) {
      (merged as Record<string, unknown>).sessionlog = entire;
    }
    return ProvidersConfigSchemaInner.parse(merged);
  });

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

// ============================================================================
// Materialization Archive Configuration
// ============================================================================

const GitArchiveConfigSchemaInner = z.object({
  /** Enable git-based archival */
  enabled: z.boolean().default(false),

  /** Branch name for archive commits */
  branch: z.string().default('opentasks/archive'),

  /** Git remote to push archive branch to */
  remote: z.string().optional(),

  /** Path to a separate git repo for the archive */
  repoPath: z.string().optional(),

  /** When to push to remote */
  pushPolicy: z.enum(['immediate', 'on-session-end', 'manual']).default('on-session-end'),
});

export const GitArchiveConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    branch: z.string().optional(),
    remote: z.string().optional(),
    repoPath: z.string().optional(),
    pushPolicy: z.enum(['immediate', 'on-session-end', 'manual']).optional(),
  })
  .default({})
  .transform((val) => GitArchiveConfigSchemaInner.parse(val));

export type GitArchiveConfig = z.infer<typeof GitArchiveConfigSchema>;

const RemoteStoreConfigSchema = z.object({
  /** Store type (resolved by factory) */
  type: z.string(),
  /** Human-readable name */
  name: z.string(),
  /** Whether this store is active */
  enabled: z.boolean().default(true),
  /** Store-specific configuration */
  config: z.record(z.string(), z.any()).default({}),
  /** Which events trigger archival to this store */
  events: z
    .array(z.enum(['session.started', 'session.checkpoint', 'session.ended']))
    .default(['session.ended']),
});

const ArchivePolicySchemaInner = z.object({
  archiveOnStart: z.boolean().default(false),
  archiveOnCheckpoint: z.boolean().default(true),
  archiveOnEnd: z.boolean().default(true),
  materializeBeforeArchive: z.boolean().default(true),
});

const MaterializationConfigSchemaInner = z.object({
  /** Graph ID — namespace in the archive tree */
  graphId: z.string().optional(),

  /** Git archive store configuration */
  git: GitArchiveConfigSchema,

  /** Remote (non-git) store configurations */
  remoteStores: z.array(RemoteStoreConfigSchema).default([]),

  /** Archive policy */
  policy: z
    .object({
      archiveOnStart: z.boolean().optional(),
      archiveOnCheckpoint: z.boolean().optional(),
      archiveOnEnd: z.boolean().optional(),
      materializeBeforeArchive: z.boolean().optional(),
    })
    .default({})
    .transform((val) => ArchivePolicySchemaInner.parse(val)),

  /** Restore missing nodes from archive on daemon startup */
  rematerializeOnStartup: z.boolean().default(false),
});

export const MaterializationConfigSchema = z
  .object({
    graphId: z.string().optional(),
    git: z
      .object({
        enabled: z.boolean().optional(),
        branch: z.string().optional(),
        remote: z.string().optional(),
        repoPath: z.string().optional(),
        pushPolicy: z.enum(['immediate', 'on-session-end', 'manual']).optional(),
      })
      .optional(),
    remoteStores: z
      .array(
        z.object({
          type: z.string(),
          name: z.string(),
          enabled: z.boolean().optional(),
          config: z.record(z.string(), z.any()).optional(),
          events: z
            .array(z.enum(['session.started', 'session.checkpoint', 'session.ended']))
            .optional(),
        }),
      )
      .optional(),
    policy: z
      .object({
        archiveOnStart: z.boolean().optional(),
        archiveOnCheckpoint: z.boolean().optional(),
        archiveOnEnd: z.boolean().optional(),
        materializeBeforeArchive: z.boolean().optional(),
      })
      .optional(),
    rematerializeOnStartup: z.boolean().optional(),
  })
  .default({})
  .transform((val) => MaterializationConfigSchemaInner.parse(val));

export type MaterializationConfig = z.infer<typeof MaterializationConfigSchema>;

// ============================================================================
// Git Graph Sync Configuration
// ============================================================================

const GitSyncConfigSchemaInner = z.object({
  /** Enable git-based graph.jsonl sync */
  enabled: z.boolean().default(false),

  /** Git remote name to push/pull (e.g., 'origin'). Omit to disable push/pull. */
  remote: z.string().optional(),

  /** Auto-commit graph.jsonl after each daemon flush */
  autoCommit: z.boolean().default(false),

  /** Auto-push to remote after commit */
  autoPush: z.boolean().default(false),

  /** Debounce interval for auto-push (ms) */
  pushDebounceMs: z.number().min(1000, 'pushDebounceMs must be >= 1000ms').default(60000),

  /** Pull from remote on daemon startup */
  pullOnStartup: z.boolean().default(false),
});

export const GitSyncConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    remote: z.string().optional(),
    autoCommit: z.boolean().optional(),
    autoPush: z.boolean().optional(),
    pushDebounceMs: z.number().min(1000, 'pushDebounceMs must be >= 1000ms').optional(),
    pullOnStartup: z.boolean().optional(),
  })
  .default({})
  .transform((val) => GitSyncConfigSchemaInner.parse(val));

export type GitSyncConfig = z.infer<typeof GitSyncConfigSchema>;

const SyncConfigSchemaInner = z.object({
  git: GitSyncConfigSchema,
});

export const SyncConfigSchema = z
  .object({
    git: z
      .object({
        enabled: z.boolean().optional(),
        remote: z.string().optional(),
        autoCommit: z.boolean().optional(),
        autoPush: z.boolean().optional(),
        pushDebounceMs: z.number().min(1000, 'pushDebounceMs must be >= 1000ms').optional(),
        pullOnStartup: z.boolean().optional(),
      })
      .optional(),
  })
  .default({})
  .transform((val) => SyncConfigSchemaInner.parse(val));

export type SyncConfig = z.infer<typeof SyncConfigSchema>;

// ============================================================================
// Tracking Configuration
// ============================================================================

const TrackingConfigSchemaInner = z.object({
  /** Enable skill usage tracking for agent sessions */
  skillTracking: z.boolean().default(false),

  /** Maximum invocations to retain per session (default: 1000) */
  maxInvocationsPerSession: z.number().min(10).default(1000),
});

export const TrackingConfigSchema = z
  .object({
    skillTracking: z.boolean().optional(),
    maxInvocationsPerSession: z.number().min(10).optional(),
  })
  .default({})
  .transform((val) => TrackingConfigSchemaInner.parse(val));

export type TrackingConfig = z.infer<typeof TrackingConfigSchema>;

// ============================================================================
// Logging Configuration
// ============================================================================

export const LoggingLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

export type LoggingLevel = z.infer<typeof LoggingLevelSchema>;

const LoggingConfigSchemaInner = z.object({
  /** Log level */
  level: LoggingLevelSchema.default('info'),

  /** Log file path (relative to .opentasks/, null = no file) */
  file: z.string().nullable().default(null),
});

export const LoggingConfigSchema = z
  .object({
    level: LoggingLevelSchema.optional(),
    file: z.string().nullable().optional(),
  })
  .default({})
  .transform((val) => LoggingConfigSchemaInner.parse(val));

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

// ============================================================================
// Root Configuration Schema
// ============================================================================

const OpenTasksConfigSchemaInner = z.object({
  version: z.string().default('1.0'),
  storage: StorageConfigSchema,
  daemon: DaemonConfigSchema,
  providers: ProvidersConfigSchema,
  logging: LoggingConfigSchema,
  /** Skill tracking configuration */
  tracking: TrackingConfigSchema,
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
  /** Materialization archive configuration */
  materialization: MaterializationConfigSchema,
  /** Graph sync configuration */
  sync: SyncConfigSchema,
});

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
            tasksDir: z.string().optional(),
          })
          .optional(),
        sudocode: z
          .object({
            enabled: z.boolean().optional(),
            executable: z.string().optional(),
            timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
          })
          .optional(),
        sessionlog: z
          .object({
            enabled: z.boolean().optional(),
            executable: z.string().optional(),
            timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
            autoLink: z.boolean().optional(),
            autoLinkMinConfidence: z.enum(['high', 'medium', 'low']).optional(),
            sessionDirName: z.string().optional(),
            checkpointsBranch: z.string().optional(),
            shadowBranchPrefix: z.string().optional(),
          })
          .optional(),
        /** @deprecated Use `sessionlog` instead */
        entire: z
          .object({
            enabled: z.boolean().optional(),
            executable: z.string().optional(),
            timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
            autoLink: z.boolean().optional(),
            autoLinkMinConfidence: z.enum(['high', 'medium', 'low']).optional(),
            sessionDirName: z.string().optional(),
            checkpointsBranch: z.string().optional(),
            shadowBranchPrefix: z.string().optional(),
          })
          .optional(),
        global: z
          .object({
            enabled: z.boolean().optional(),
            path: z.string().optional(),
            timeout: z.number().min(1000, 'timeout must be >= 1000ms').optional(),
            cacheTTL: z.number().min(0, 'cacheTTL must be >= 0').optional(),
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
    tracking: z
      .object({
        skillTracking: z.boolean().optional(),
        maxInvocationsPerSession: z.number().min(10).optional(),
      })
      .optional(),
    location: z
      .object({
        hash: z.string().optional(),
        uuid: z.string().uuid().optional(),
        name: z.string().optional(),
      })
      .optional(),
    connections: z
      .array(
        z.object({
          hash: z.string(),
          path: z.string(),
          role: ConnectionRoleSchema.optional(),
          name: z.string().optional(),
        }),
      )
      .optional(),
    role: z.enum(['manager', 'worker', 'standalone']).optional(),
    redirects: z
      .array(
        z.object({
          operations: z.array(RedirectOperationSchema),
          pattern: z.string().optional(),
          target: z.string(),
          priority: z.number().optional(),
          fallback: z.enum(['local', 'error']).optional(),
        }),
      )
      .optional(),
    defaultProvider: z.string().optional(),
    sync: z
      .object({
        git: z
          .object({
            enabled: z.boolean().optional(),
            remote: z.string().optional(),
            autoCommit: z.boolean().optional(),
            autoPush: z.boolean().optional(),
            pushDebounceMs: z.number().min(1000, 'pushDebounceMs must be >= 1000ms').optional(),
            pullOnStartup: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    materialization: z
      .object({
        graphId: z.string().optional(),
        git: z
          .object({
            enabled: z.boolean().optional(),
            branch: z.string().optional(),
            remote: z.string().optional(),
            repoPath: z.string().optional(),
            pushPolicy: z.enum(['immediate', 'on-session-end', 'manual']).optional(),
          })
          .optional(),
        remoteStores: z
          .array(
            z.object({
              type: z.string(),
              name: z.string(),
              enabled: z.boolean().optional(),
              config: z.record(z.string(), z.any()).optional(),
              events: z
                .array(z.enum(['session.started', 'session.checkpoint', 'session.ended']))
                .optional(),
            }),
          )
          .optional(),
        policy: z
          .object({
            archiveOnStart: z.boolean().optional(),
            archiveOnCheckpoint: z.boolean().optional(),
            archiveOnEnd: z.boolean().optional(),
            materializeBeforeArchive: z.boolean().optional(),
          })
          .optional(),
        rematerializeOnStartup: z.boolean().optional(),
      })
      .optional(),
  })
  .default({})
  .transform((val) => OpenTasksConfigSchemaInner.parse(val));

export type OpenTasksConfig = z.infer<typeof OpenTasksConfigSchema>;

// ============================================================================
// Partial Configuration Type (for merging)
// ============================================================================

/** Deep partial type for config merging */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type PartialOpenTasksConfig = DeepPartial<OpenTasksConfig>;

// ============================================================================
// Validation Utilities
// ============================================================================

export interface ValidationResult {
  success: boolean;
  data?: OpenTasksConfig;
  errors?: Array<{
    path: string;
    message: string;
  }>;
}

/**
 * Validate a configuration object
 */
export function validateConfig(config: unknown): ValidationResult {
  const result = OpenTasksConfigSchema.safeParse(config);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  return {
    success: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/**
 * Parse and validate a configuration, throwing on error
 */
export function parseConfig(config: unknown): OpenTasksConfig {
  return OpenTasksConfigSchema.parse(config);
}
