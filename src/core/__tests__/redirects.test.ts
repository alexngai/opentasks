import { describe, it, expect } from 'vitest';
import {
  matchPattern,
  findRedirectRule,
  resolveOperationRedirect,
  type RedirectRule,
} from '../redirects.js';
import type { Connection } from '../connections.js';
import type { LocationIdentity } from '../location.js';

describe('matchPattern', () => {
  it('matches wildcard (*)', () => {
    expect(matchPattern('*', 'i-x7k9')).toBe(true);
    expect(matchPattern('*', 's-a2b3')).toBe(true);
  });

  it('matches prefix patterns', () => {
    expect(matchPattern('i-*', 'i-x7k9')).toBe(true);
    expect(matchPattern('i-*', 's-a2b3')).toBe(false);
    expect(matchPattern('s-*', 's-a2b3')).toBe(true);
    expect(matchPattern('x-*', 'x-edge1')).toBe(true);
  });

  it('matches exact IDs', () => {
    expect(matchPattern('i-x7k9', 'i-x7k9')).toBe(true);
    expect(matchPattern('i-x7k9', 'i-other')).toBe(false);
  });
});

describe('findRedirectRule', () => {
  const rules: RedirectRule[] = [
    {
      operations: ['read', 'write'],
      pattern: 's-*',
      target: 'opentasks://specs1/.',
      priority: 50,
      fallback: 'error',
    },
    {
      operations: ['read', 'write'],
      pattern: '*',
      target: 'opentasks://main1/',
      priority: 100,
      fallback: 'local',
    },
    {
      operations: ['read'],
      pattern: 'i-*',
      target: 'opentasks://issues/',
      priority: 75,
      fallback: 'error',
    },
  ];

  it('returns highest priority matching rule', () => {
    const rule = findRedirectRule('read', 's-a2b3', rules);
    expect(rule?.priority).toBe(50);
    expect(rule?.target).toBe('opentasks://specs1/.');
  });

  it('skips rules that dont match operation', () => {
    // The read-only rule at priority 75 for i-* should be skipped for writes
    const rule = findRedirectRule('write', 'i-x7k9', rules);
    // Should match the wildcard at priority 100, not the read-only at 75
    expect(rule?.priority).toBe(100);
  });

  it('returns null when no rules match', () => {
    const result = findRedirectRule('read', 'i-x7k9', []);
    expect(result).toBeNull();
  });

  it('respects priority order (lower = higher priority)', () => {
    const rule = findRedirectRule('read', 'i-x7k9', rules);
    // i-* at priority 75 should match before * at priority 100
    expect(rule?.priority).toBe(75);
  });
});

describe('resolveOperationRedirect', () => {
  const currentLocation: LocationIdentity = {
    hash: 'abcd1234',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    name: 'current',
  };
  const currentPath = '/home/user/project/.opentasks';

  const connections: Connection[] = [
    {
      hash: 'k7m2x9p4',
      path: '/home/user/main-repo/.opentasks',
      role: 'peer',
      name: 'main-repo',
    },
  ];

  it('returns not-redirected when no rules match', () => {
    const result = resolveOperationRedirect(
      'read',
      'i-x7k9',
      [],
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.redirected).toBe(false);
  });

  it('resolves redirect to connected location', () => {
    const rules: RedirectRule[] = [
      {
        operations: ['read', 'write'],
        pattern: '*',
        target: 'opentasks://k7m2x9p4/',
        priority: 100,
        fallback: 'error',
      },
    ];

    const result = resolveOperationRedirect(
      'read',
      'i-x7k9',
      rules,
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.redirected).toBe(true);
    expect(result.targetLocation?.hash).toBe('k7m2x9p4');
  });

  it('falls back to local when target is unreachable with fallback=local', () => {
    const rules: RedirectRule[] = [
      {
        operations: ['read'],
        pattern: '*',
        target: 'opentasks://nonexist/',
        priority: 100,
        fallback: 'local',
      },
    ];

    const result = resolveOperationRedirect(
      'read',
      'i-x7k9',
      rules,
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.redirected).toBe(false);
  });

  it('throws when target unreachable with fallback=error', () => {
    const rules: RedirectRule[] = [
      {
        operations: ['read'],
        pattern: '*',
        target: 'opentasks://nonexist/',
        priority: 100,
        fallback: 'error',
      },
    ];

    expect(() =>
      resolveOperationRedirect('read', 'i-x7k9', rules, connections, currentLocation, currentPath),
    ).toThrow('Redirect target unreachable');
  });
});
