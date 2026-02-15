import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { LockedJsonlWriter, deduplicateNodes, deduplicateEdges } from '../locked-writer.js'
import type { StoredNode, StoredEdge } from '../../schema/storage.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-writer-test-'))
  // Create the base dir structure
  fs.mkdirSync(path.join(tmpDir, '.opentasks'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeNode(id: string, title: string, updatedAt: string): StoredNode {
  return {
    id,
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    type: 'task',
    title,
    status: 'open',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: updatedAt,
  }
}

function makeEdge(id: string, fromId: string, toId: string): StoredEdge {
  return {
    id,
    uuid: '550e8400-e29b-41d4-a716-446655440001',
    from_id: fromId,
    to_id: toId,
    type: 'blocks',
    created_at: '2025-01-01T00:00:00Z',
  }
}

describe('LockedJsonlWriter', () => {
  it('appends entries with lock', async () => {
    const basePath = path.join(tmpDir, '.opentasks')
    const writer = new LockedJsonlWriter({ basePath })

    const node = makeNode('t-test', 'Test Task', '2025-01-01T00:00:00Z')
    await writer.appendLocked(node)

    const { nodes } = await writer.load()
    expect(nodes).toHaveLength(1)
    expect(nodes[0].id).toBe('t-test')
  })

  it('appends multiple entries atomically', async () => {
    const basePath = path.join(tmpDir, '.opentasks')
    const writer = new LockedJsonlWriter({ basePath })

    const nodes = [
      makeNode('t-1', 'First', '2025-01-01T00:00:00Z'),
      makeNode('t-2', 'Second', '2025-01-01T00:00:00Z'),
    ]
    await writer.appendManyLocked(nodes)

    const result = await writer.load()
    expect(result.nodes).toHaveLength(2)
  })

  it('saves with lock', async () => {
    const basePath = path.join(tmpDir, '.opentasks')
    const writer = new LockedJsonlWriter({ basePath })

    const nodes = [makeNode('t-1', 'First', '2025-01-01T00:00:00Z')]
    const edges = [makeEdge('x-1', 't-1', 't-2')]

    await writer.saveLocked(nodes, edges)

    const result = await writer.load()
    expect(result.nodes).toHaveLength(1)
    expect(result.edges).toHaveLength(1)
  })

  it('releases lock file after operation', async () => {
    const basePath = path.join(tmpDir, '.opentasks')
    const writer = new LockedJsonlWriter({ basePath })

    await writer.appendLocked(
      makeNode('t-test', 'Test', '2025-01-01T00:00:00Z')
    )

    // Lock file should be cleaned up
    expect(fs.existsSync(path.join(basePath, 'write.lock'))).toBe(false)
  })
})

describe('deduplicateNodes', () => {
  it('keeps latest version of each node', () => {
    const nodes: StoredNode[] = [
      makeNode('t-1', 'Old', '2025-01-01T10:00:00Z'),
      makeNode('t-1', 'New', '2025-01-01T12:00:00Z'),
      makeNode('t-2', 'Other', '2025-01-01T11:00:00Z'),
    ]

    const result = deduplicateNodes(nodes)
    expect(result).toHaveLength(2)

    const node1 = result.find((n) => n.id === 't-1')
    expect(node1?.title).toBe('New')
    expect(node1?.updated_at).toBe('2025-01-01T12:00:00Z')
  })

  it('handles single entries', () => {
    const nodes = [makeNode('t-1', 'Only', '2025-01-01T10:00:00Z')]
    const result = deduplicateNodes(nodes)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Only')
  })

  it('handles empty array', () => {
    expect(deduplicateNodes([])).toHaveLength(0)
  })
})

describe('deduplicateEdges', () => {
  it('deduplicates edges by ID', () => {
    const edges: StoredEdge[] = [
      makeEdge('x-1', 't-1', 't-2'),
      makeEdge('x-1', 't-1', 't-3'), // Same ID, different target
      makeEdge('x-2', 't-2', 't-3'),
    ]

    const result = deduplicateEdges(edges)
    expect(result).toHaveLength(2)
  })
})
