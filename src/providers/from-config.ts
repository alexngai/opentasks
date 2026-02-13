/**
 * Provider Factory from Configuration
 *
 * Creates providers based on OpenTasksConfig settings.
 */

import { createBeadsProvider } from './beads.js'
import { createClaudeTasksProvider } from './claude-tasks.js'
import { createEntireProvider } from './entire.js'
import { createNativeProvider } from './native.js'
import { createSudocodeProvider } from './sudocode.js'
import { createProviderRegistry } from './registry.js'
import type { Provider, ProviderRegistry } from './types.js'
import type { GraphStore } from '../graph/store.js'
import type { OpenTasksConfig } from '../config/schema.js'

/**
 * Options for creating providers from config
 */
export interface CreateProvidersOptions {
  /** OpenTasks configuration */
  config: OpenTasksConfig

  /** GraphStore for native provider */
  graphStore: GraphStore

  /** Working directory for Beads (default: process.cwd()) */
  beadsCwd?: string

  /** Working directory for Sudocode (default: process.cwd()) */
  sudocodeCwd?: string
}

/**
 * Result of creating providers from config
 */
export interface CreateProvidersResult {
  /** The provider registry with all enabled providers */
  registry: ProviderRegistry

  /** List of providers that were created */
  providers: Provider[]

  /** List of providers that were skipped (disabled in config) */
  skipped: string[]

  /** List of providers that failed to initialize (with error) */
  failed: Array<{ name: string; error: Error }>
}

/**
 * Check if a CLI executable is available
 */
async function isCliAvailable(executable: string): Promise<boolean> {
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)

  try {
    await execAsync(`${executable} --version`, { timeout: 5000 })
    return true
  } catch {
    return false
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
  options: CreateProvidersOptions
): Promise<CreateProvidersResult> {
  const { config, graphStore, beadsCwd, sudocodeCwd } = options
  const registry = createProviderRegistry()
  const providers: Provider[] = []
  const skipped: string[] = []
  const failed: Array<{ name: string; error: Error }> = []

  // 1. Native provider (always created)
  const nativeProvider = createNativeProvider(graphStore)
  registry.register(nativeProvider)
  providers.push(nativeProvider)

  // 2. Beads provider (if enabled)
  if (config.providers.beads.enabled) {
    const beadsConfig = config.providers.beads
    const isAvailable = await isCliAvailable(beadsConfig.executable)

    if (isAvailable) {
      try {
        const beadsProvider = createBeadsProvider({
          executable: beadsConfig.executable,
          timeout: beadsConfig.timeout,
          cwd: beadsCwd,
        })
        registry.register(beadsProvider)
        providers.push(beadsProvider)
      } catch (error) {
        failed.push({
          name: 'beads',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    } else {
      // Enabled but not available - skip silently (per spec)
      skipped.push('beads')
    }
  } else {
    skipped.push('beads')
  }

  // 3. Claude Tasks provider (if enabled)
  if (config.providers.claudeTasks.enabled) {
    try {
      const claudeTasksProvider = createClaudeTasksProvider()
      registry.register(claudeTasksProvider)
      providers.push(claudeTasksProvider)
    } catch (error) {
      failed.push({
        name: 'claude',
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  } else {
    skipped.push('claude')
  }

  // 4. Sudocode provider (if enabled)
  if (config.providers.sudocode.enabled) {
    const sudocodeConfig = config.providers.sudocode
    const isAvailable = await isCliAvailable(sudocodeConfig.executable)

    if (isAvailable) {
      try {
        const sudocodeProvider = createSudocodeProvider({
          executable: sudocodeConfig.executable,
          timeout: sudocodeConfig.timeout,
          cwd: sudocodeCwd,
        })
        registry.register(sudocodeProvider)
        providers.push(sudocodeProvider)
      } catch (error) {
        failed.push({
          name: 'sudocode',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    } else {
      // Enabled but not available - skip silently (per spec)
      skipped.push('sudocode')
    }
  } else {
    skipped.push('sudocode')
  }

  // 5. Entire provider (if enabled)
  if (config.providers.entire.enabled) {
    const entireConfig = config.providers.entire
    const isAvailable = await isCliAvailable(entireConfig.executable)

    if (isAvailable) {
      try {
        const entireProvider = createEntireProvider({
          executable: entireConfig.executable,
          timeout: entireConfig.timeout,
        })
        registry.register(entireProvider)
        providers.push(entireProvider)
      } catch (error) {
        failed.push({
          name: 'entire',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    } else {
      // Enabled but not available - skip silently (per spec)
      skipped.push('entire')
    }
  } else {
    skipped.push('entire')
  }

  return { registry, providers, skipped, failed }
}
