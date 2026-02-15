/**
 * Provider Registry
 *
 * Routes operations to appropriate providers based on ID/URI scheme.
 */

import type { Provider, ProviderRegistry } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for local node IDs (c-, t-, f-, e-, x-)
 */
const LOCAL_ID_PATTERN = /^[ctfex]-[a-z0-9]+$/;

/**
 * Pattern for URI with scheme
 */
const URI_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a new provider registry
 */
export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, Provider>();
  const schemeMap = new Map<string, Provider>();

  return {
    /**
     * Register a provider
     */
    register(provider: Provider): void {
      // Store by name
      providers.set(provider.name, provider);

      // Map all schemes to this provider
      for (const scheme of provider.schemes) {
        schemeMap.set(scheme.toLowerCase(), provider);
      }
    },

    /**
     * Unregister a provider by name
     */
    unregister(name: string): void {
      const provider = providers.get(name);
      if (!provider) return;

      // Remove from providers map
      providers.delete(name);

      // Remove scheme mappings
      for (const scheme of provider.schemes) {
        const mapped = schemeMap.get(scheme.toLowerCase());
        if (mapped === provider) {
          schemeMap.delete(scheme.toLowerCase());
        }
      }
    },

    /**
     * Get a provider by name
     */
    get(name: string): Provider | undefined {
      return providers.get(name);
    },

    /**
     * Find provider that can handle a URI or ID
     */
    resolveProvider(idOrUri: string): Provider | null {
      // Check if it's a URI with scheme (case-insensitive)
      const schemeMatch = idOrUri.toLowerCase().match(URI_SCHEME_PATTERN);
      if (schemeMatch) {
        const scheme = schemeMatch[1];
        return schemeMap.get(scheme) || null;
      }

      // Check if it's a local ID (c-, t-, f-, e-, x-)
      if (LOCAL_ID_PATTERN.test(idOrUri)) {
        return providers.get('native') || null;
      }

      // Try each provider's parseUri to see if any can handle it
      for (const provider of providers.values()) {
        if (provider.parseUri(idOrUri)) {
          return provider;
        }
      }

      return null;
    },

    /**
     * List all registered providers
     */
    list(): Provider[] {
      return Array.from(providers.values());
    },

    /**
     * Check if a URI/ID can be resolved
     */
    canResolve(idOrUri: string): boolean {
      return this.resolveProvider(idOrUri) !== null;
    },
  };
}
