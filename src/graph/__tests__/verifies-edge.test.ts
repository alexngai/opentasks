/**
 * Step 2 of the attempt/verify schema: the `verifies` / `reproduces` edges.
 * See docs/ATTEMPT-VERIFY-SCHEMA.md §5.
 */

import { describe, it, expect } from 'vitest';
import { createEdgeTypeRegistry } from '../EdgeTypeRegistry.js';
import { createValidationService } from '../validation.js';
import type { StoredNode } from '../../schema/storage.js';

describe('verifies / reproduces edges (step 2)', () => {
  const registry = createEdgeTypeRegistry();

  it('registers verifies with its inverse and affectsReady=false', () => {
    expect(registry.lookup('verifies')).not.toBeNull();
    expect(registry.getInverse('verifies')).toBe('verified-by');
    expect(registry.affectsReady('verifies')).toBe(false);
  });

  it('registers reproduces with its inverse', () => {
    expect(registry.has('reproduces')).toBe(true);
    expect(registry.getInverse('reproduces')).toBe('reproduced-by');
    expect(registry.affectsReady('reproduces')).toBe(false);
  });

  it('does not let verification edges affect ready status', () => {
    expect(registry.getReadyAffectingTypes()).not.toContain('verifies');
    expect(registry.getReadyAffectingTypes()).not.toContain('reproduces');
  });

  it('accepts a verifies edge (with verdict/evidence metadata) between existing nodes', async () => {
    const validation = createValidationService();
    const nodes: Record<string, StoredNode> = {
      'a-1': { id: 'a-1', uuid: 'u1', type: 'attempt', title: 'verifier', target_id: 't-1', created_at: 'n', updated_at: 'n' },
      'a-2': { id: 'a-2', uuid: 'u2', type: 'attempt', title: 'verified', target_id: 't-1', created_at: 'n', updated_at: 'n' },
    };
    const res = await validation.validateCreateEdge(
      { from_id: 'a-1', to_id: 'a-2', type: 'verifies', metadata: { verdict: 'pass', verifier: 'B' } },
      async (id) => nodes[id] ?? null,
    );
    expect(res.valid).toBe(true);
    expect(res.errors.find((e) => e.code === 'INVALID_EDGE_TYPE')).toBeUndefined();
  });

  it('still rejects an unknown edge type', async () => {
    const validation = createValidationService();
    const res = await validation.validateCreateEdge(
      { from_id: 'a-1', to_id: 'a-2', type: 'bogus-edge' },
      async () => null,
    );
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'INVALID_EDGE_TYPE')).toBe(true);
  });
});
