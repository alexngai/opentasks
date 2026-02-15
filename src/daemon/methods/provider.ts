/**
 * Provider Method Handlers
 *
 * JSON-RPC method handlers for provider enumeration and introspection.
 * Allows agents and tools to discover available providers and their capabilities.
 */

import type { IPCServer } from '../ipc.js';
import type { LocationResolver } from '../location-state.js';
import type { Provider } from '../../providers/types.js';
import { isTaskManageable } from '../../providers/traits/TaskManageable.js';
import type { TaskCapabilities } from '../../providers/traits/TaskManageable.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for registering provider methods
 */
export interface ProviderMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer;

  /** Location resolver for routing to correct store */
  locationResolver: LocationResolver;
}

/**
 * Summary of a registered provider
 */
interface ProviderSummary {
  /** Provider name */
  name: string;

  /** URI schemes this provider handles */
  schemes: string[];

  /** Provider capabilities */
  capabilities: {
    read: boolean;
    write: boolean;
    search: boolean;
    watch: boolean;
    mount: boolean;
    feedback: boolean;
  };

  /** Whether this is the default provider for creates */
  isDefault: boolean;

  /** Task lifecycle capabilities (only present if provider supports tasks) */
  taskCapabilities?: TaskCapabilities;
}

/**
 * Result of provider.list
 */
interface ProviderListResult {
  /** Registered providers */
  providers: ProviderSummary[];

  /** The configured default provider name */
  defaultProvider: string;
}

/**
 * Result of provider.info
 */
interface ProviderInfoResult {
  /** Provider details */
  provider: ProviderSummary | null;

  /** Error message if provider not found */
  error?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Build a ProviderSummary from a Provider, including optional task capabilities
 */
function toProviderSummary(provider: Provider, defaultProvider: string): ProviderSummary {
  const summary: ProviderSummary = {
    name: provider.name,
    schemes: [...provider.schemes],
    capabilities: {
      read: provider.capabilities.read,
      write: provider.capabilities.write,
      search: provider.capabilities.search,
      watch: provider.capabilities.watch,
      mount: provider.capabilities.mount,
      feedback: provider.capabilities.feedback,
    },
    isDefault:
      provider.name === defaultProvider || provider.schemes.some((s) => s === defaultProvider),
  };

  if (isTaskManageable(provider)) {
    summary.taskCapabilities = { ...provider.taskCapabilities };
  }

  return summary;
}

/**
 * Register provider method handlers on an IPC server
 */
export function registerProviderMethods(options: ProviderMethodsOptions): void {
  const { server, locationResolver } = options;

  // provider.list - List all registered providers with capabilities
  server.handle<{ location?: string }, ProviderListResult>('provider.list', async (params) => {
    const { location } = params || {};
    const state = locationResolver.resolve(location);

    if (!state.providerStore) {
      return { providers: [], defaultProvider: 'native' };
    }

    const providers = state.providerStore.providers.list();
    const defaultProvider = state.providerStore.defaultProvider;

    return {
      providers: providers.map((p) => toProviderSummary(p, defaultProvider)),
      defaultProvider,
    };
  });

  // provider.info - Get detailed info about a specific provider
  server.handle<{ name: string; location?: string }, ProviderInfoResult>(
    'provider.info',
    async (params) => {
      const { name, location } = params || {};
      if (!name) {
        return { provider: null, error: 'Missing required parameter: name' };
      }

      const state = locationResolver.resolve(location);

      if (!state.providerStore) {
        return { provider: null, error: 'Provider store not available' };
      }

      const provider = state.providerStore.providers.get(name);
      if (!provider) {
        return { provider: null, error: `Provider not found: ${name}` };
      }

      const defaultProvider = state.providerStore.defaultProvider;

      return {
        provider: toProviderSummary(provider, defaultProvider),
      };
    },
  );
}
