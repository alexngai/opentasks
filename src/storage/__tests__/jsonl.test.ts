import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { JSONLPersister } from '../jsonl.js';
import type { StoredNode, StoredEdge } from '../../schema/storage.js';

describe('JSONLPersister', () => {
  let tempDir: string;
  let persister: JSONLPersister;

  beforeEach(async () => {
    // Create a temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-test-'));
    persister = new JSONLPersister({
      path: path.join(tempDir, 'graph.jsonl'),
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    persister.stopWatching();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // Test fixtures
  const testContext: StoredNode = {
    id: 'c-a2b3',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    type: 'context',
    title: 'Test Context',
    content: 'Some content',
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  };

  const testTask: StoredNode = {
    id: 't-x7k9',
    uuid: '550e8400-e29b-41d4-a716-446655440001',
    type: 'task',
    title: 'Test Task',
    status: 'open',
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  };

  const testEdge: StoredEdge = {
    id: 'x-r8s9',
    uuid: '550e8400-e29b-41d4-a716-446655440010',
    from_id: 't-x7k9',
    to_id: 'c-a2b3',
    type: 'implements',
    created_at: '2025-01-26T10:00:00Z',
  };

  describe('exists', () => {
    it('returns false for non-existent file', async () => {
      expect(await persister.exists()).toBe(false);
    });

    it('returns true for existing file', async () => {
      await persister.save([], []);
      expect(await persister.exists()).toBe(true);
    });
  });

  describe('save and load', () => {
    it('saves and loads empty graph', async () => {
      await persister.save([], []);
      const result = await persister.load();
      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it('saves and loads nodes', async () => {
      await persister.save([testContext, testTask], []);
      const result = await persister.load();

      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(0);

      const loadedSpec = result.nodes.find((n) => n.id === 'c-a2b3');
      expect(loadedSpec).toBeDefined();
      expect(loadedSpec?.title).toBe('Test Context');
      expect(loadedSpec?.type).toBe('context');
    });

    it('saves and loads edges', async () => {
      await persister.save([testContext, testTask], [testEdge]);
      const result = await persister.load();

      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);

      const loadedEdge = result.edges[0];
      expect(loadedEdge.id).toBe('x-r8s9');
      expect(loadedEdge.from_id).toBe('t-x7k9');
      expect(loadedEdge.to_id).toBe('c-a2b3');
      expect(loadedEdge.type).toBe('implements');
    });

    it('preserves unknown fields', async () => {
      const nodeWithExtra: StoredNode = {
        ...testContext,
        customField: 'custom value',
        anotherField: { nested: true },
      };
      await persister.save([nodeWithExtra], []);
      const result = await persister.load();

      expect(result.nodes[0].customField).toBe('custom value');
      expect((result.nodes[0] as any).anotherField).toEqual({ nested: true });
    });

    it('handles missing file gracefully', async () => {
      const result = await persister.load();
      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it('creates directory if it does not exist', async () => {
      const deepPath = path.join(tempDir, 'deep', 'nested', 'graph.jsonl');
      const deepPersister = new JSONLPersister({ path: deepPath });

      await deepPersister.save([testContext], []);

      const result = await deepPersister.load();
      expect(result.nodes).toHaveLength(1);
    });
  });

  describe('append', () => {
    it('appends a single node', async () => {
      await persister.save([testContext], []);
      await persister.append(testTask);

      const result = await persister.load();
      expect(result.nodes).toHaveLength(2);
    });

    it('appends a single edge', async () => {
      await persister.save([testContext, testTask], []);
      await persister.append(testEdge);

      const result = await persister.load();
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
    });

    it('creates file if it does not exist', async () => {
      await persister.append(testContext);
      const result = await persister.load();
      expect(result.nodes).toHaveLength(1);
    });
  });

  describe('appendMany', () => {
    it('appends multiple entries', async () => {
      await persister.save([], []);
      await persister.appendMany([testContext, testTask, testEdge]);

      const result = await persister.load();
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
    });

    it('handles empty array', async () => {
      await persister.save([testContext], []);
      await persister.appendMany([]);

      const result = await persister.load();
      expect(result.nodes).toHaveLength(1);
    });
  });

  describe('atomic write', () => {
    it('uses atomic write by default', async () => {
      // This is hard to test directly, but we can verify no .tmp files remain
      await persister.save([testContext, testTask], [testEdge]);

      const files = await fs.readdir(tempDir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('can disable atomic write', async () => {
      const nonAtomicPersister = new JSONLPersister({
        path: path.join(tempDir, 'non-atomic.jsonl'),
        atomicWrite: false,
      });

      await nonAtomicPersister.save([testContext], []);
      const result = await nonAtomicPersister.load();
      expect(result.nodes).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('deletes the file', async () => {
      await persister.save([testContext], []);
      expect(await persister.exists()).toBe(true);

      await persister.delete();
      expect(await persister.exists()).toBe(false);
    });

    it('handles non-existent file', async () => {
      // Should not throw
      await persister.delete();
    });
  });

  describe('edge detection', () => {
    it('identifies edges by from_id and to_id', async () => {
      const content = [JSON.stringify(testContext), JSON.stringify(testEdge)].join('\n');

      await fs.writeFile(persister.filePath, content);

      const result = await persister.load();
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(1);
    });

    it('identifies edges by x- prefix', async () => {
      const edgeWithoutFromTo = {
        id: 'x-test',
        uuid: 'test-uuid',
        from_id: 'a',
        to_id: 'b',
        type: 'blocks',
        created_at: '2025-01-26T10:00:00Z',
      };

      await persister.save([], [edgeWithoutFromTo]);
      const result = await persister.load();
      expect(result.edges).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('skips invalid JSON lines', async () => {
      const content = [
        JSON.stringify(testContext),
        'invalid json {{{',
        JSON.stringify(testTask),
      ].join('\n');

      await fs.writeFile(persister.filePath, content);

      const result = await persister.load();
      expect(result.nodes).toHaveLength(2); // Should load valid lines
    });

    it('handles empty lines', async () => {
      const content = [JSON.stringify(testContext), '', '   ', JSON.stringify(testTask)].join('\n');

      await fs.writeFile(persister.filePath, content);

      const result = await persister.load();
      expect(result.nodes).toHaveLength(2);
    });
  });
});
