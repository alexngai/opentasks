/**
 * Tests for Reconcilable trait
 */

import { describe, it, expect, vi } from 'vitest';
import { isReconcilable } from '../Reconcilable.js';
import type { Provider } from '../../types.js';

describe('Reconcilable', () => {
  const baseProvider: Provider = {
    name: 'test',
    schemes: ['test'],
    capabilities: { read: true, write: true, search: false, watch: false, mount: false, feedback: false },
    parseUri: vi.fn(),
    buildUri: vi.fn(),
    isValidUri: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  it('returns false for providers without listForReconciliation', () => {
    expect(isReconcilable(baseProvider)).toBe(false);
  });

  it('returns true for providers with listForReconciliation', () => {
    const reconcilable = {
      ...baseProvider,
      listForReconciliation: vi.fn().mockResolvedValue([]),
    };
    expect(isReconcilable(reconcilable)).toBe(true);
  });

  it('returns false when listForReconciliation is not a function', () => {
    const notReconcilable = {
      ...baseProvider,
      listForReconciliation: 'not a function',
    };
    expect(isReconcilable(notReconcilable as unknown as Provider)).toBe(false);
  });
});
