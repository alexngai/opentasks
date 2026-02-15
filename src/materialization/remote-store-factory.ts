/**
 * Remote Store Factory
 *
 * Creates RemoteStore instances from configuration.
 * Resolves store type to the appropriate implementation.
 */

import type { RemoteStore, RemoteStoreConfig } from './types.js'
import { createHttpRemoteStore } from './http-remote-store.js'
import { createGitRemoteStore } from './git-remote-store.js'

/**
 * Registry of remote store factories by type
 */
const storeFactories = new Map<string, (config: RemoteStoreConfig) => RemoteStore>([
  ['http', createHttpRemoteStore],
  ['webhook', createHttpRemoteStore],
  ['git-remote', createGitRemoteStore],
])

/**
 * Register a custom remote store factory
 */
export function registerRemoteStoreFactory(
  type: string,
  factory: (config: RemoteStoreConfig) => RemoteStore
): void {
  storeFactories.set(type, factory)
}

/**
 * Create remote stores from an array of config entries.
 * Skips unknown store types with a warning (non-fatal).
 */
export function createRemoteStoresFromConfig(
  configs: RemoteStoreConfig[]
): RemoteStore[] {
  const stores: RemoteStore[] = []

  for (const config of configs) {
    if (!config.enabled) continue

    const factory = storeFactories.get(config.type)
    if (!factory) {
      // Unknown store type — skip with warning
      continue
    }

    try {
      stores.push(factory(config))
    } catch {
      // Factory error — skip this store
    }
  }

  return stores
}
