/**
 * Tests for Materialization Config Schema
 */

import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../config/schema.js';

describe('Materialization Config Schema', () => {
  it('should parse empty config with defaults', () => {
    const config = parseConfig({});

    expect(config.materialization).toBeDefined();
    expect(config.materialization.git.enabled).toBe(false);
    expect(config.materialization.git.branch).toBe('opentasks/archive');
    expect(config.materialization.git.pushPolicy).toBe('on-session-end');
    expect(config.materialization.remoteStores).toEqual([]);
    expect(config.materialization.policy.archiveOnStart).toBe(false);
    expect(config.materialization.policy.archiveOnCheckpoint).toBe(true);
    expect(config.materialization.policy.archiveOnEnd).toBe(true);
    expect(config.materialization.policy.materializeBeforeArchive).toBe(true);
    expect(config.materialization.rematerializeOnStartup).toBe(false);
  });

  it('should parse explicit git config', () => {
    const config = parseConfig({
      materialization: {
        graphId: 'my-service',
        git: {
          enabled: true,
          branch: 'archive/v2',
          remote: 'origin',
          pushPolicy: 'immediate',
        },
      },
    });

    expect(config.materialization.graphId).toBe('my-service');
    expect(config.materialization.git.enabled).toBe(true);
    expect(config.materialization.git.branch).toBe('archive/v2');
    expect(config.materialization.git.remote).toBe('origin');
    expect(config.materialization.git.pushPolicy).toBe('immediate');
  });

  it('should parse remote store config', () => {
    const config = parseConfig({
      materialization: {
        remoteStores: [
          {
            type: 'http',
            name: 'analytics',
            enabled: true,
            config: { url: 'https://example.com/ingest' },
            events: ['session.ended'],
          },
        ],
      },
    });

    expect(config.materialization.remoteStores.length).toBe(1);
    expect(config.materialization.remoteStores[0].type).toBe('http');
    expect(config.materialization.remoteStores[0].name).toBe('analytics');
    expect(config.materialization.remoteStores[0].events).toEqual(['session.ended']);
  });

  it('should parse policy overrides', () => {
    const config = parseConfig({
      materialization: {
        policy: {
          archiveOnStart: true,
          archiveOnCheckpoint: false,
        },
      },
    });

    expect(config.materialization.policy.archiveOnStart).toBe(true);
    expect(config.materialization.policy.archiveOnCheckpoint).toBe(false);
    expect(config.materialization.policy.archiveOnEnd).toBe(true); // default
  });

  it('should parse separate repo config', () => {
    const config = parseConfig({
      materialization: {
        graphId: 'payments-service',
        git: {
          enabled: true,
          repoPath: '/shared/opentasks-archive',
          remote: 'origin',
        },
      },
    });

    expect(config.materialization.git.repoPath).toBe('/shared/opentasks-archive');
    expect(config.materialization.graphId).toBe('payments-service');
  });

  it('should validate push policy enum', () => {
    expect(() =>
      parseConfig({
        materialization: {
          git: {
            pushPolicy: 'invalid-value' as never,
          },
        },
      }),
    ).toThrow();
  });

  it('should validate remote store event enum', () => {
    expect(() =>
      parseConfig({
        materialization: {
          remoteStores: [
            {
              type: 'http',
              name: 'test',
              events: ['invalid.event' as never],
            },
          ],
        },
      }),
    ).toThrow();
  });
});
