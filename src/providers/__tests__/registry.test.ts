/**
 * Tests for Provider Registry
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createProviderRegistry } from '../registry.js';
import type { Provider, ProviderRegistry, ParsedUri } from '../types.js';

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  // Mock providers for testing
  const createMockProvider = (
    name: string,
    schemes: string[],
    parseResult: ParsedUri | null = null,
  ): Provider => ({
    name,
    schemes,
    capabilities: {
      read: true,
      write: true,
      search: false,
      watch: false,
      mount: true,
      feedback: false,
    },
    parseUri: (uri: string): ParsedUri | null => {
      for (const scheme of schemes) {
        if (uri.startsWith(`${scheme}://`)) {
          return {
            scheme,
            id: uri.split('/').pop() || '',
            isRelative: uri.includes('/./'),
          };
        }
      }
      return parseResult;
    },
    buildUri: (id: string) => `${schemes[0]}://./${id}`,
    isValidUri: (uri: string) => schemes.some((s) => uri.startsWith(`${s}://`)),
    get: async () => null,
    list: async () => [],
    create: async (input) => ({
      id: 'new-1',
      uri: `${schemes[0]}://./new-1`,
      type: input.type,
      title: input.title,
      fetchedAt: new Date().toISOString(),
    }),
    update: async (id, updates) => ({
      id,
      uri: `${schemes[0]}://./${id}`,
      type: 'issue',
      title: updates.title || 'Updated',
      fetchedAt: new Date().toISOString(),
    }),
    delete: async () => {},
  });

  const nativeProvider = createMockProvider('native', ['native', 'opentasks']);
  const beadsProvider = createMockProvider('beads', ['beads', 'bd']);
  const claudeProvider = createMockProvider('claude', ['claude', 'task']);

  beforeEach(() => {
    registry = createProviderRegistry();
  });

  describe('register/unregister', () => {
    it('should register a provider', () => {
      registry.register(nativeProvider);

      expect(registry.get('native')).toBe(nativeProvider);
    });

    it('should register multiple providers', () => {
      registry.register(nativeProvider);
      registry.register(beadsProvider);
      registry.register(claudeProvider);

      expect(registry.list()).toHaveLength(3);
    });

    it('should unregister a provider', () => {
      registry.register(nativeProvider);
      registry.register(beadsProvider);

      registry.unregister('native');

      expect(registry.get('native')).toBeUndefined();
      expect(registry.get('beads')).toBe(beadsProvider);
    });

    it('should handle unregistering non-existent provider', () => {
      // Should not throw
      registry.unregister('nonexistent');
    });

    it('should remove scheme mappings on unregister', () => {
      registry.register(nativeProvider);
      registry.unregister('native');

      expect(registry.resolveProvider('native://c-abc1')).toBeNull();
    });
  });

  describe('get', () => {
    it('should get provider by name', () => {
      registry.register(nativeProvider);

      expect(registry.get('native')).toBe(nativeProvider);
    });

    it('should return undefined for unknown provider', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });
  });

  describe('resolveProvider', () => {
    beforeEach(() => {
      registry.register(nativeProvider);
      registry.register(beadsProvider);
      registry.register(claudeProvider);
    });

    it('should resolve local IDs to native provider', () => {
      expect(registry.resolveProvider('c-abc1')).toBe(nativeProvider);
      expect(registry.resolveProvider('t-xyz2')).toBe(nativeProvider);
      expect(registry.resolveProvider('f-def3')).toBe(nativeProvider);
      expect(registry.resolveProvider('e-ghi4')).toBe(nativeProvider);
      expect(registry.resolveProvider('x-jkl5')).toBe(nativeProvider);
    });

    it('should resolve beads:// URIs to beads provider', () => {
      expect(registry.resolveProvider('beads://./bd-123')).toBe(beadsProvider);
      expect(registry.resolveProvider('beads://workspace/bd-456')).toBe(beadsProvider);
    });

    it('should resolve bd:// shorthand to beads provider', () => {
      expect(registry.resolveProvider('bd://./bd-789')).toBe(beadsProvider);
    });

    it('should resolve claude:// URIs to claude provider', () => {
      expect(registry.resolveProvider('claude://current/t-abc')).toBe(claudeProvider);
      expect(registry.resolveProvider('claude://session-123/t-def')).toBe(claudeProvider);
    });

    it('should resolve task:// shorthand to claude provider', () => {
      expect(registry.resolveProvider('task://current/t-xyz')).toBe(claudeProvider);
    });

    it('should resolve native:// URIs to native provider', () => {
      expect(registry.resolveProvider('native://c-abc1')).toBe(nativeProvider);
      expect(registry.resolveProvider('opentasks://t-xyz2')).toBe(nativeProvider);
    });

    it('should return null for unknown schemes', () => {
      expect(registry.resolveProvider('unknown://something')).toBeNull();
      expect(registry.resolveProvider('jira://PROJ-123')).toBeNull();
    });

    it('should return null for invalid IDs', () => {
      expect(registry.resolveProvider('invalid')).toBeNull();
      expect(registry.resolveProvider('not-a-valid-id')).toBeNull();
    });

    it('should be case-insensitive for schemes', () => {
      expect(registry.resolveProvider('BEADS://./bd-123')).toBe(beadsProvider);
      expect(registry.resolveProvider('Beads://./bd-456')).toBe(beadsProvider);
    });

    it('should return null when native provider not registered', () => {
      const emptyRegistry = createProviderRegistry();
      expect(emptyRegistry.resolveProvider('c-abc1')).toBeNull();
    });
  });

  describe('list', () => {
    it('should return empty array when no providers', () => {
      expect(registry.list()).toEqual([]);
    });

    it('should return all registered providers', () => {
      registry.register(nativeProvider);
      registry.register(beadsProvider);

      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list).toContain(nativeProvider);
      expect(list).toContain(beadsProvider);
    });
  });

  describe('canResolve', () => {
    beforeEach(() => {
      registry.register(nativeProvider);
      registry.register(beadsProvider);
    });

    it('should return true for resolvable IDs', () => {
      expect(registry.canResolve('c-abc1')).toBe(true);
      expect(registry.canResolve('beads://./bd-123')).toBe(true);
    });

    it('should return false for unresolvable IDs', () => {
      expect(registry.canResolve('unknown://something')).toBe(false);
      expect(registry.canResolve('invalid-id')).toBe(false);
    });
  });

  describe('fallback to parseUri', () => {
    it('should try provider parseUri for non-standard formats', () => {
      // Create a provider that handles a custom format
      const customProvider: Provider = {
        ...createMockProvider('custom', ['custom']),
        parseUri: (uri: string) => {
          // Handle format like "CUSTOM-123"
          if (uri.match(/^CUSTOM-\d+$/)) {
            return { scheme: 'custom', id: uri, isRelative: false };
          }
          return null;
        },
      };

      registry.register(customProvider);

      expect(registry.resolveProvider('CUSTOM-123')).toBe(customProvider);
      expect(registry.resolveProvider('CUSTOM-456')).toBe(customProvider);
      expect(registry.resolveProvider('OTHER-789')).toBeNull();
    });
  });
});
