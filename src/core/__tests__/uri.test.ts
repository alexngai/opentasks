import { describe, it, expect } from 'vitest';
import {
  parseOpentasksUri,
  resolveLocationTarget,
  resolveOpentasksUri,
  isOpentasksUri,
  buildOpentasksUri,
  buildLocalUri,
} from '../uri.js';
import type { Connection } from '../connections.js';
import type { LocationIdentity } from '../location.js';

describe('parseOpentasksUri', () => {
  it('parses hash-based URIs', () => {
    const result = parseOpentasksUri('opentasks://k7m2x9p4/i-x7k9');
    expect(result).toEqual({
      scheme: 'opentasks',
      locationHash: 'k7m2x9p4',
      nodeId: 'i-x7k9',
    });
  });

  it('parses current-location URIs', () => {
    const result = parseOpentasksUri('opentasks://./i-x7k9');
    expect(result).toEqual({
      scheme: 'opentasks',
      relativePath: './',
      nodeId: 'i-x7k9',
    });
  });

  it('parses absolute-path URIs', () => {
    const result = parseOpentasksUri('opentasks:///home/user/.opentasks/s-g8h9');
    expect(result).toEqual({
      scheme: 'opentasks',
      absolutePath: '/home/user/.opentasks',
      nodeId: 's-g8h9',
    });
  });

  it('returns null for non-opentasks URIs', () => {
    expect(parseOpentasksUri('beads://./bd-123')).toBeNull();
    expect(parseOpentasksUri('https://example.com')).toBeNull();
    expect(parseOpentasksUri('not-a-uri')).toBeNull();
  });

  it('returns null for malformed opentasks URIs', () => {
    expect(parseOpentasksUri('opentasks://')).toBeNull();
    expect(parseOpentasksUri('opentasks://hash')).toBeNull();
    expect(parseOpentasksUri('opentasks://hash/')).toBeNull();
    expect(parseOpentasksUri('opentasks://./')).toBeNull();
  });
});

describe('isOpentasksUri', () => {
  it('returns true for opentasks URIs', () => {
    expect(isOpentasksUri('opentasks://hash/id')).toBe(true);
    expect(isOpentasksUri('opentasks://./id')).toBe(true);
  });

  it('returns false for other URIs', () => {
    expect(isOpentasksUri('beads://./bd-123')).toBe(false);
    expect(isOpentasksUri('i-x7k9')).toBe(false);
  });
});

describe('buildOpentasksUri', () => {
  it('builds hash-based URI', () => {
    expect(buildOpentasksUri('k7m2x9p4', 'i-x7k9')).toBe('opentasks://k7m2x9p4/i-x7k9');
  });
});

describe('buildLocalUri', () => {
  it('builds local URI', () => {
    expect(buildLocalUri('i-x7k9')).toBe('opentasks://./i-x7k9');
  });
});

describe('resolveOpentasksUri', () => {
  const currentLocation: LocationIdentity = {
    hash: 'abcd1234',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    name: 'current',
  };
  const currentPath = '/home/user/project/.opentasks';

  const connections: Connection[] = [
    {
      hash: 'k7m2x9p4',
      path: '/home/user/other-repo/.opentasks',
      role: 'peer',
      name: 'other-repo',
    },
    {
      hash: 'm3p8q2w5',
      path: '../shared/.opentasks',
      role: 'parent',
      name: 'shared',
    },
  ];

  it('resolves current-location shorthand', () => {
    const result = resolveOpentasksUri(
      'opentasks://./i-x7k9',
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.opentasksPath).toBe(currentPath);
    expect(result.hash).toBe('abcd1234');
    expect(result.nodeId).toBe('i-x7k9');
    expect(result.isLocal).toBe(true);
  });

  it('resolves hash-based URI via connections', () => {
    const result = resolveOpentasksUri(
      'opentasks://k7m2x9p4/i-x7k9',
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.opentasksPath).toBe('/home/user/other-repo/.opentasks');
    expect(result.hash).toBe('k7m2x9p4');
    expect(result.nodeId).toBe('i-x7k9');
    expect(result.isLocal).toBe(false);
  });

  it('resolves current location hash as local', () => {
    const result = resolveOpentasksUri(
      'opentasks://abcd1234/i-x7k9',
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.isLocal).toBe(true);
    expect(result.hash).toBe('abcd1234');
  });

  it('throws for unknown hash', () => {
    expect(() =>
      resolveOpentasksUri('opentasks://unknown1/i-x7k9', connections, currentLocation, currentPath),
    ).toThrow('Unknown location hash: unknown1');
  });

  it('throws for invalid URI', () => {
    expect(() =>
      resolveOpentasksUri('not-a-uri', connections, currentLocation, currentPath),
    ).toThrow('Invalid opentasks URI');
  });
});

describe('resolveLocationTarget', () => {
  const currentLocation: LocationIdentity = {
    hash: 'abcd1234',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    name: 'current',
  };
  const currentPath = '/home/user/project/.opentasks';

  const connections: Connection[] = [
    {
      hash: 'k7m2x9p4',
      path: '/home/user/other-repo/.opentasks',
      role: 'peer',
      name: 'other-repo',
    },
  ];

  it('resolves bare hash to connected location', () => {
    const result = resolveLocationTarget('k7m2x9p4', connections, currentLocation, currentPath);
    expect(result.hash).toBe('k7m2x9p4');
    expect(result.opentasksPath).toBe('/home/user/other-repo/.opentasks');
    expect(result.isLocal).toBe(false);
  });

  it('resolves bare hash matching current location as local', () => {
    const result = resolveLocationTarget('abcd1234', connections, currentLocation, currentPath);
    expect(result.hash).toBe('abcd1234');
    expect(result.isLocal).toBe(true);
  });

  it('resolves "." as current location', () => {
    const result = resolveLocationTarget('.', connections, currentLocation, currentPath);
    expect(result.hash).toBe('abcd1234');
    expect(result.opentasksPath).toBe(currentPath);
    expect(result.isLocal).toBe(true);
  });

  it('resolves hash-based URI (with trailing slash)', () => {
    const result = resolveLocationTarget(
      'opentasks://k7m2x9p4/',
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.hash).toBe('k7m2x9p4');
    expect(result.isLocal).toBe(false);
  });

  it('resolves hash-based URI (with node ID) to location only', () => {
    const result = resolveLocationTarget(
      'opentasks://k7m2x9p4/i-node1',
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.hash).toBe('k7m2x9p4');
    expect(result.isLocal).toBe(false);
    expect('nodeId' in result).toBe(false);
  });

  it('resolves current-location URI', () => {
    const result = resolveLocationTarget(
      'opentasks://./',
      connections,
      currentLocation,
      currentPath,
    );
    expect(result.hash).toBe('abcd1234');
    expect(result.isLocal).toBe(true);
  });

  it('throws for unknown hash', () => {
    expect(() =>
      resolveLocationTarget('unknown1', connections, currentLocation, currentPath),
    ).toThrow('Unknown location hash: unknown1');
  });
});
