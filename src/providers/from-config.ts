/**
 * Provider Factory from Configuration
 *
 * Creates providers based on OpenTasksConfig settings.
 */

import { createBeadsProvider } from './beads.js';
import { createClaudeTasksProvider, type ClaudeTasksConfig } from './claude-tasks.js';
import { createSessionlogProvider, createSessionlogCliStoreAsync } from './sessionlog.js';
import { createGlobalProvider } from './global.js';
import { createMAPProvider, type MAPTaskClient } from './map.js';
import { createNativeProvider } from './native.js';
import { createSudocodeProvider } from './sudocode.js';
import { createProviderRegistry } from './registry.js';
import type { Provider, ProviderRegistry } from './types.js';
import type { GraphStore } from '../graph/store.js';
import type { OpenTasksConfig } from '../config/schema.js';

/**
 * Options for creating providers from config
 */
export interface CreateProvidersOptions {
  /** OpenTasks configuration */
  config: OpenTasksConfig;

  /** GraphStore for native provider */
  graphStore: GraphStore;

  /** Working directory for Beads (default: process.cwd()) */
  beadsCwd?: string;

  /** Working directory for Sudocode (default: process.cwd()) */
  sudocodeCwd?: string;

  /** MAP task client for MAP provider (required if map provider is enabled) */
  mapClient?: MAPTaskClient;
}

/**
 * Result of creating providers from config
 */
export interface CreateProvidersResult {
  /** The provider registry with all enabled providers */
  registry: ProviderRegistry;

  /** List of providers that were created */
  providers: Provider[];

  /** List of providers that were skipped (disabled in config) */
  skipped: string[];

  /** List of providers that failed to initialize (with error) */
  failed: Array<{ name: string; error: Error }>;
}

/**
 * Apply materializeMode config override to a provider.
 * Only sets the property if the config specifies a non-default mode.
 */
function applyMaterializeMode<T extends Provider>(
  provider: T,
  mode: 'cached' | 'pointer',
): T {
  if (mode !== 'cached') {
    return Object.assign(provider, { materializeMode: mode });
  }
  return provider;
}

/**
 * Check if a CLI executable is available
 */
async function isCliAvailable(executable: string): Promise<boolean> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    await execAsync(`${executable} --version`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create and register providers based on configuration
 *
 * - Creates native provider (always)
 * - Creates beads provider if enabled and executable found
 * - Creates claude-tasks provider if enabled
 * - Creates sudocode provider if enabled and executable found
 */
export async function createProvidersFromConfig(
  options: CreateProvidersOptions,
): Promise<CreateProvidersResult> {
  const { config, graphStore, beadsCwd, sudocodeCwd } = options;
  const registry = createProviderRegistry();
  const providers: Provider[] = [];
  const skipped: string[] = [];
  const failed: Array<{ name: string; error: Error }> = [];

  // 1. Native provider (always created)
  const nativeProvider = createNativeProvider(graphStore);
  registry.register(nativeProvider);
  providers.push(nativeProvider);

  // 2. Beads provider (if enabled)
  if (config.providers.beads.enabled) {
    const beadsConfig = config.providers.beads;
    const isAvailable = await isCliAvailable(beadsConfig.executable);

    if (isAvailable) {
      try {
        const beadsProvider = applyMaterializeMode(
          createBeadsProvider({
            executable: beadsConfig.executable,
            timeout: beadsConfig.timeout,
            cwd: beadsCwd,
          }),
          beadsConfig.materializeMode,
        );
        registry.register(beadsProvider);
        providers.push(beadsProvider);
      } catch (error) {
        failed.push({
          name: 'beads',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    } else {
      // Enabled but not available - skip silently (per spec)
      skipped.push('beads');
    }
  } else {
    skipped.push('beads');
  }

  // 3. Claude Tasks provider (if enabled)
  if (config.providers.claudeTasks.enabled) {
    try {
      const claudeConfig: ClaudeTasksConfig = {};
      if (config.providers.claudeTasks.tasksDir) {
        const { createFilesystemTaskStore } = await import('./claude-tasks-fs.js');
        claudeConfig.taskStore = createFilesystemTaskStore({
          basePath: config.providers.claudeTasks.tasksDir,
        });
        claudeConfig.tasksDir = config.providers.claudeTasks.tasksDir;
      }
      const claudeTasksProvider = applyMaterializeMode(
        createClaudeTasksProvider(claudeConfig),
        config.providers.claudeTasks.materializeMode,
      );
      registry.register(claudeTasksProvider);
      providers.push(claudeTasksProvider);
    } catch (error) {
      failed.push({
        name: 'claude',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  } else {
    skipped.push('claude');
  }

  // 4. Sudocode provider (if enabled)
  if (config.providers.sudocode.enabled) {
    const sudocodeConfig = config.providers.sudocode;
    const isAvailable = await isCliAvailable(sudocodeConfig.executable);

    if (isAvailable) {
      try {
        const sudocodeProvider = applyMaterializeMode(
          createSudocodeProvider({
            executable: sudocodeConfig.executable,
            timeout: sudocodeConfig.timeout,
            cwd: sudocodeCwd,
          }),
          sudocodeConfig.materializeMode,
        );
        registry.register(sudocodeProvider);
        providers.push(sudocodeProvider);
      } catch (error) {
        failed.push({
          name: 'sudocode',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    } else {
      // Enabled but not available - skip silently (per spec)
      skipped.push('sudocode');
    }
  } else {
    skipped.push('sudocode');
  }

  // 5. Sessionlog provider (if enabled)
  // Uses built-in TS store by default. If an executable is configured,
  // tries the Go CLI first and falls back to the TS store if unavailable.
  if (config.providers.sessionlog.enabled) {
    const sessionlogConfig = config.providers.sessionlog;
    try {
      const store = await createSessionlogCliStoreAsync({
        executable: sessionlogConfig.executable,
        timeout: sessionlogConfig.timeout,
      });
      const sessionlogProvider = createSessionlogProvider(
        { timeout: sessionlogConfig.timeout },
        store,
      );
      registry.register(sessionlogProvider);
      providers.push(sessionlogProvider);
    } catch (error) {
      failed.push({
        name: 'sessionlog',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  } else {
    skipped.push('sessionlog');
  }

  // 6. Global provider (if enabled)
  if (config.providers.global.enabled) {
    const globalConfig = config.providers.global;
    try {
      const globalProvider = createGlobalProvider({
        globalPath: globalConfig.path || undefined,
        timeout: globalConfig.timeout,
        cacheTTL: globalConfig.cacheTTL,
      });
      registry.register(globalProvider);
      providers.push(globalProvider);
    } catch (error) {
      failed.push({
        name: 'global',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  } else {
    skipped.push('global');
  }

  // 7. MAP provider (if enabled and client provided)
  if (config.providers.map.enabled) {
    if (options.mapClient) {
      try {
        const mapConfig = config.providers.map;
        const mapProvider = createMAPProvider({
          client: options.mapClient,
          systemId: mapConfig.systemId,
          timeout: mapConfig.timeout,
        });
        registry.register(mapProvider);
        providers.push(mapProvider);
      } catch (error) {
        failed.push({
          name: 'map',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    } else {
      // Enabled but no client provided — skip
      skipped.push('map');
    }
  } else {
    skipped.push('map');
  }

  return { registry, providers, skipped, failed };
}
