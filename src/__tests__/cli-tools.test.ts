/**
 * Tests for CLI Tool Commands
 *
 * Tests link, query, annotate, create, get, update, delete commands
 * by calling the exported functions with a mocked OpenTasksClient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the client module before importing CLI functions
const mockClient = {
  link: vi.fn(),
  query: vi.fn(),
  annotate: vi.fn(),
  createNode: vi.fn(),
  getNode: vi.fn(),
  updateNode: vi.fn(),
  deleteNode: vi.fn(),
  disconnect: vi.fn(),
}

vi.mock('../client/client.js', () => ({
  OpenTasksClient: vi.fn().mockImplementation(function () {
    return mockClient
  }),
}))

// Mock process.exit to throw instead of exiting
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`)
}) as any)

import {
  cmdLink,
  cmdQuery,
  cmdAnnotate,
  cmdCreate,
  cmdGet,
  cmdUpdate,
  cmdDelete,
  getFlag,
  hasFlag,
} from '../cli.js'

// ============================================================================
// Helpers
// ============================================================================

let logOutput: string[]
let errorOutput: string[]
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

function getLoggedJson(): any {
  const json = logOutput.join('')
  return JSON.parse(json)
}

// ============================================================================
// Tests
// ============================================================================

describe('CLI Tool Commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    logOutput = []
    errorOutput = []

    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logOutput.push(args.map(String).join(' '))
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      errorOutput.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  // ==========================================================================
  // Helper functions
  // ==========================================================================

  describe('getFlag', () => {
    it('should return flag value', () => {
      expect(getFlag(['--from', 'i-test1', '--to', 's-test1'], '--from')).toBe('i-test1')
      expect(getFlag(['--from', 'i-test1', '--to', 's-test1'], '--to')).toBe('s-test1')
    })

    it('should return undefined for missing flag', () => {
      expect(getFlag(['--from', 'i-test1'], '--to')).toBeUndefined()
    })

    it('should return undefined for empty args', () => {
      expect(getFlag([], '--from')).toBeUndefined()
    })
  })

  describe('hasFlag', () => {
    it('should return true when flag present', () => {
      expect(hasFlag(['--remove', '--from', 'x'], '--remove')).toBe(true)
    })

    it('should return false when flag absent', () => {
      expect(hasFlag(['--from', 'x'], '--remove')).toBe(false)
    })
  })

  // ==========================================================================
  // link
  // ==========================================================================

  describe('cmdLink', () => {
    it('should create an edge between nodes', async () => {
      mockClient.link.mockResolvedValueOnce({ success: true, edgeId: 'x-new1' })

      await cmdLink(['--from', 'i-test1', '--to', 's-test1', '--type', 'implements'])

      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
      })

      const result = getLoggedJson()
      expect(result.success).toBe(true)
      expect(result.edgeId).toBe('x-new1')
    })

    it('should remove an edge with --remove', async () => {
      mockClient.link.mockResolvedValueOnce({ success: true })

      await cmdLink(['--from', 'i-test1', '--to', 's-test1', '--type', 'implements', '--remove'])

      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
        remove: true,
      })
    })

    it('should pass metadata as parsed JSON', async () => {
      mockClient.link.mockResolvedValueOnce({ success: true, edgeId: 'x-new2' })

      await cmdLink([
        '--from', 'i-test1', '--to', 's-test1', '--type', 'references',
        '--metadata', '{"context":"bug report"}',
      ])

      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'references',
        metadata: { context: 'bug report' },
      })
    })

    it('should disconnect after success', async () => {
      mockClient.link.mockResolvedValueOnce({ success: true })

      await cmdLink(['--from', 'i-test1', '--to', 's-test1', '--type', 'implements'])

      expect(mockClient.disconnect).toHaveBeenCalled()
    })

    it('should error on missing --from', async () => {
      await expect(
        cmdLink(['--to', 's-test1', '--type', 'implements'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
      expect(mockClient.link).not.toHaveBeenCalled()
    })

    it('should error on missing --to', async () => {
      await expect(
        cmdLink(['--from', 'i-test1', '--type', 'implements'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
    })

    it('should error on missing --type', async () => {
      await expect(
        cmdLink(['--from', 'i-test1', '--to', 's-test1'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
    })

    it('should handle RPC errors', async () => {
      mockClient.link.mockRejectedValueOnce(new Error('Connection refused'))

      await expect(
        cmdLink(['--from', 'i-test1', '--to', 's-test1', '--type', 'blocks'])
      ).rejects.toThrow('process.exit(1)')

      const errorJson = JSON.parse(errorOutput.join(''))
      expect(errorJson.error).toContain('Connection refused')
    })
  })

  // ==========================================================================
  // query
  // ==========================================================================

  describe('cmdQuery', () => {
    it('should query ready work', async () => {
      mockClient.query.mockResolvedValueOnce({
        items: [{ id: 'i-1', title: 'Ready Issue' }],
        hasMore: false,
      })

      await cmdQuery(['{"ready":{}}'])

      expect(mockClient.query).toHaveBeenCalledWith({ ready: {} })

      const result = getLoggedJson()
      expect(result.items).toHaveLength(1)
      expect(result.items[0].id).toBe('i-1')
    })

    it('should query nodes with filter', async () => {
      mockClient.query.mockResolvedValueOnce({
        items: [{ id: 's-1' }],
        hasMore: false,
      })

      await cmdQuery(['{"nodes":{"type":"spec"}}'])

      expect(mockClient.query).toHaveBeenCalledWith({ nodes: { type: 'spec' } })
    })

    it('should query edges', async () => {
      mockClient.query.mockResolvedValueOnce({
        items: [{ id: 'x-1', from_id: 'i-1', to_id: 's-1' }],
        hasMore: false,
      })

      await cmdQuery(['{"edges":{"from_id":"i-1"}}'])

      expect(mockClient.query).toHaveBeenCalledWith({ edges: { from_id: 'i-1' } })
    })

    it('should query blockers with options', async () => {
      mockClient.query.mockResolvedValueOnce({
        items: [{ id: 's-1', title: 'Blocker' }],
        hasMore: false,
      })

      await cmdQuery(['{"blockers":{"nodeId":"i-1","activeOnly":true,"transitive":true}}'])

      expect(mockClient.query).toHaveBeenCalledWith({
        blockers: { nodeId: 'i-1', activeOnly: true, transitive: true },
      })
    })

    it('should query implementers', async () => {
      mockClient.query.mockResolvedValueOnce({
        items: [{ id: 'i-1' }],
        hasMore: false,
      })

      await cmdQuery(['{"implementers":{"specId":"s-1"}}'])

      expect(mockClient.query).toHaveBeenCalledWith({ implementers: { specId: 's-1' } })
    })

    it('should query feedback', async () => {
      mockClient.query.mockResolvedValueOnce({
        items: [{ id: 'f-1' }],
        hasMore: false,
      })

      await cmdQuery(['{"feedback":{"nodeId":"s-1","resolved":false}}'])

      expect(mockClient.query).toHaveBeenCalledWith({
        feedback: { nodeId: 's-1', resolved: false },
      })
    })

    it('should query unresolved feedback', async () => {
      mockClient.query.mockResolvedValueOnce({ items: [], hasMore: false })

      await cmdQuery(['{"unresolvedFeedback":{}}'])

      expect(mockClient.query).toHaveBeenCalledWith({ unresolvedFeedback: {} })
    })

    it('should disconnect after success', async () => {
      mockClient.query.mockResolvedValueOnce({ items: [], hasMore: false })

      await cmdQuery(['{"ready":{}}'])

      expect(mockClient.disconnect).toHaveBeenCalled()
    })

    it('should error on missing JSON argument', async () => {
      await expect(cmdQuery([])).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
      expect(mockClient.query).not.toHaveBeenCalled()
    })

    it('should error on invalid JSON', async () => {
      await expect(
        cmdQuery(['not-valid-json'])
      ).rejects.toThrow('process.exit(1)')

      const errorJson = JSON.parse(errorOutput.join(''))
      expect(errorJson.error).toBeDefined()
    })
  })

  // ==========================================================================
  // annotate
  // ==========================================================================

  describe('cmdAnnotate', () => {
    it('should create feedback', async () => {
      mockClient.annotate.mockResolvedValueOnce({ success: true, feedbackId: 'f-new1' })

      await cmdAnnotate(['{"targetId":"s-1","create":{"content":"Nice work","type":"comment"}}'])

      expect(mockClient.annotate).toHaveBeenCalledWith({
        targetId: 's-1',
        create: { content: 'Nice work', type: 'comment' },
      })

      const result = getLoggedJson()
      expect(result.success).toBe(true)
      expect(result.feedbackId).toBe('f-new1')
    })

    it('should create feedback with fromId', async () => {
      mockClient.annotate.mockResolvedValueOnce({ success: true, feedbackId: 'f-new2' })

      await cmdAnnotate(['{"targetId":"s-1","fromId":"i-1","create":{"content":"Done","type":"comment"}}'])

      expect(mockClient.annotate).toHaveBeenCalledWith({
        targetId: 's-1',
        fromId: 'i-1',
        create: { content: 'Done', type: 'comment' },
      })
    })

    it('should create anchored suggestion', async () => {
      mockClient.annotate.mockResolvedValueOnce({ success: true, feedbackId: 'f-new3' })

      await cmdAnnotate(['{"targetId":"s-1","create":{"content":"Add rate limiting","type":"suggestion","anchor":{"line":15}}}'])

      expect(mockClient.annotate).toHaveBeenCalledWith({
        targetId: 's-1',
        create: { content: 'Add rate limiting', type: 'suggestion', anchor: { line: 15 } },
      })
    })

    it('should resolve feedback', async () => {
      mockClient.annotate.mockResolvedValueOnce({ success: true })

      await cmdAnnotate(['{"targetId":"s-1","resolve":"f-1"}'])

      expect(mockClient.annotate).toHaveBeenCalledWith({
        targetId: 's-1',
        resolve: 'f-1',
      })
    })

    it('should dismiss feedback', async () => {
      mockClient.annotate.mockResolvedValueOnce({ success: true })

      await cmdAnnotate(['{"targetId":"s-1","dismiss":"f-1"}'])

      expect(mockClient.annotate).toHaveBeenCalledWith({
        targetId: 's-1',
        dismiss: 'f-1',
      })
    })

    it('should reopen feedback', async () => {
      mockClient.annotate.mockResolvedValueOnce({ success: true })

      await cmdAnnotate(['{"targetId":"s-1","reopen":"f-1"}'])

      expect(mockClient.annotate).toHaveBeenCalledWith({
        targetId: 's-1',
        reopen: 'f-1',
      })
    })

    it('should error on missing JSON argument', async () => {
      await expect(cmdAnnotate([])).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
    })

    it('should error on invalid JSON', async () => {
      await expect(
        cmdAnnotate(['{bad json}'])
      ).rejects.toThrow('process.exit(1)')
    })

    it('should handle RPC errors', async () => {
      mockClient.annotate.mockRejectedValueOnce(new Error('Target not found'))

      await expect(
        cmdAnnotate(['{"targetId":"s-nonexistent","create":{"content":"x","type":"comment"}}'])
      ).rejects.toThrow('process.exit(1)')

      const errorJson = JSON.parse(errorOutput.join(''))
      expect(errorJson.error).toContain('Target not found')
    })
  })

  // ==========================================================================
  // create
  // ==========================================================================

  describe('cmdCreate', () => {
    it('should create an issue node', async () => {
      mockClient.createNode.mockResolvedValueOnce({
        id: 'i-new1', type: 'issue', title: 'New Issue', status: 'open',
      })

      await cmdCreate(['--type', 'issue', '--title', 'New Issue', '--status', 'open'])

      expect(mockClient.createNode).toHaveBeenCalledWith({
        type: 'issue',
        title: 'New Issue',
        status: 'open',
      })

      const result = getLoggedJson()
      expect(result.id).toBe('i-new1')
      expect(result.type).toBe('issue')
    })

    it('should create a spec node', async () => {
      mockClient.createNode.mockResolvedValueOnce({
        id: 's-new1', type: 'spec', title: 'Auth Spec', content: '## Reqs',
      })

      await cmdCreate(['--type', 'spec', '--title', 'Auth Spec', '--content', '## Reqs'])

      expect(mockClient.createNode).toHaveBeenCalledWith({
        type: 'spec',
        title: 'Auth Spec',
        content: '## Reqs',
      })
    })

    it('should create an external node with uri and source', async () => {
      mockClient.createNode.mockResolvedValueOnce({
        id: 'e-new1', type: 'external', title: 'Slack Msg',
        uri: 'slack://C04ABCD/p123', source: 'slack',
      })

      await cmdCreate([
        '--type', 'external', '--title', 'Slack Msg',
        '--uri', 'slack://C04ABCD/p123', '--source', 'slack',
      ])

      expect(mockClient.createNode).toHaveBeenCalledWith({
        type: 'external',
        title: 'Slack Msg',
        uri: 'slack://C04ABCD/p123',
        source: 'slack',
      })
    })

    it('should parse comma-separated tags', async () => {
      mockClient.createNode.mockResolvedValueOnce({ id: 'i-new1' })

      await cmdCreate(['--type', 'issue', '--title', 'Tagged', '--tags', 'auth,bug,urgent'])

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['auth', 'bug', 'urgent'],
        })
      )
    })

    it('should trim whitespace from tags', async () => {
      mockClient.createNode.mockResolvedValueOnce({ id: 'i-new1' })

      await cmdCreate(['--type', 'issue', '--title', 'Tagged', '--tags', 'auth, bug, urgent'])

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['auth', 'bug', 'urgent'],
        })
      )
    })

    it('should parse priority as number', async () => {
      mockClient.createNode.mockResolvedValueOnce({ id: 'i-new1' })

      await cmdCreate(['--type', 'issue', '--title', 'Prio', '--priority', '2'])

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 2 })
      )
    })

    it('should pass metadata as parsed JSON', async () => {
      mockClient.createNode.mockResolvedValueOnce({ id: 'i-new1' })

      await cmdCreate([
        '--type', 'issue', '--title', 'Meta',
        '--metadata', '{"source_url":"https://example.com"}',
      ])

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { source_url: 'https://example.com' },
        })
      )
    })

    it('should pass parent ID', async () => {
      mockClient.createNode.mockResolvedValueOnce({ id: 'i-new1' })

      await cmdCreate(['--type', 'issue', '--title', 'Child', '--parent', 's-test1'])

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({ parent_id: 's-test1' })
      )
    })

    it('should only include specified options', async () => {
      mockClient.createNode.mockResolvedValueOnce({ id: 'i-new1' })

      await cmdCreate(['--type', 'issue', '--title', 'Minimal'])

      expect(mockClient.createNode).toHaveBeenCalledWith({
        type: 'issue',
        title: 'Minimal',
      })
    })

    it('should error on missing --type', async () => {
      await expect(
        cmdCreate(['--title', 'No Type'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
      expect(mockClient.createNode).not.toHaveBeenCalled()
    })

    it('should error on missing --title', async () => {
      await expect(
        cmdCreate(['--type', 'issue'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
    })
  })

  // ==========================================================================
  // get
  // ==========================================================================

  describe('cmdGet', () => {
    it('should get a node by ID', async () => {
      mockClient.getNode.mockResolvedValueOnce({
        id: 's-test1', type: 'spec', title: 'Test Spec',
      })

      await cmdGet(['s-test1'])

      expect(mockClient.getNode).toHaveBeenCalledWith('s-test1')

      const result = getLoggedJson()
      expect(result.id).toBe('s-test1')
      expect(result.title).toBe('Test Spec')
    })

    it('should return null for non-existent node', async () => {
      mockClient.getNode.mockResolvedValueOnce(null)

      await cmdGet(['i-nonexistent'])

      expect(mockClient.getNode).toHaveBeenCalledWith('i-nonexistent')

      const result = getLoggedJson()
      expect(result).toBeNull()
    })

    it('should disconnect after success', async () => {
      mockClient.getNode.mockResolvedValueOnce({ id: 's-1' })

      await cmdGet(['s-1'])

      expect(mockClient.disconnect).toHaveBeenCalled()
    })

    it('should error on missing ID', async () => {
      await expect(cmdGet([])).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
      expect(mockClient.getNode).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // update
  // ==========================================================================

  describe('cmdUpdate', () => {
    it('should update status', async () => {
      mockClient.updateNode.mockResolvedValueOnce({
        id: 'i-test1', status: 'closed',
      })

      await cmdUpdate(['i-test1', '--status', 'closed'])

      expect(mockClient.updateNode).toHaveBeenCalledWith('i-test1', {
        status: 'closed',
      })

      const result = getLoggedJson()
      expect(result.status).toBe('closed')
    })

    it('should update title', async () => {
      mockClient.updateNode.mockResolvedValueOnce({
        id: 's-test1', title: 'Updated Title',
      })

      await cmdUpdate(['s-test1', '--title', 'Updated Title'])

      expect(mockClient.updateNode).toHaveBeenCalledWith('s-test1', {
        title: 'Updated Title',
      })
    })

    it('should set archived flag', async () => {
      mockClient.updateNode.mockResolvedValueOnce({
        id: 'i-test1', archived: true,
      })

      await cmdUpdate(['i-test1', '--archived'])

      expect(mockClient.updateNode).toHaveBeenCalledWith('i-test1', {
        archived: true,
      })
    })

    it('should update metadata as parsed JSON', async () => {
      mockClient.updateNode.mockResolvedValueOnce({
        id: 'i-test1', metadata: { reviewed: true },
      })

      await cmdUpdate(['i-test1', '--metadata', '{"reviewed":true}'])

      expect(mockClient.updateNode).toHaveBeenCalledWith('i-test1', {
        metadata: { reviewed: true },
      })
    })

    it('should update multiple fields at once', async () => {
      mockClient.updateNode.mockResolvedValueOnce({
        id: 'i-test1', status: 'in_progress', title: 'Renamed',
      })

      await cmdUpdate(['i-test1', '--status', 'in_progress', '--title', 'Renamed'])

      expect(mockClient.updateNode).toHaveBeenCalledWith('i-test1', {
        status: 'in_progress',
        title: 'Renamed',
      })
    })

    it('should error on missing ID', async () => {
      await expect(cmdUpdate([])).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
      expect(mockClient.updateNode).not.toHaveBeenCalled()
    })

    it('should error when no updates specified', async () => {
      await expect(cmdUpdate(['i-test1'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('No updates specified')
      expect(mockClient.updateNode).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // delete
  // ==========================================================================

  describe('cmdDelete', () => {
    it('should soft delete a node', async () => {
      mockClient.deleteNode.mockResolvedValueOnce(undefined)

      await cmdDelete(['i-test1'])

      expect(mockClient.deleteNode).toHaveBeenCalledWith('i-test1', undefined)

      const result = getLoggedJson()
      expect(result.success).toBe(true)
      expect(result.id).toBe('i-test1')
      expect(result.hard).toBe(false)
    })

    it('should hard delete with --hard', async () => {
      mockClient.deleteNode.mockResolvedValueOnce(undefined)

      await cmdDelete(['i-test1', '--hard'])

      expect(mockClient.deleteNode).toHaveBeenCalledWith('i-test1', { hard: true })

      const result = getLoggedJson()
      expect(result.success).toBe(true)
      expect(result.hard).toBe(true)
    })

    it('should disconnect after success', async () => {
      mockClient.deleteNode.mockResolvedValueOnce(undefined)

      await cmdDelete(['i-test1'])

      expect(mockClient.disconnect).toHaveBeenCalled()
    })

    it('should error on missing ID', async () => {
      await expect(cmdDelete([])).rejects.toThrow('process.exit(1)')

      expect(errorOutput.join('')).toContain('Usage:')
      expect(mockClient.deleteNode).not.toHaveBeenCalled()
    })

    it('should handle RPC errors', async () => {
      mockClient.deleteNode.mockRejectedValueOnce(new Error('Node not found'))

      await expect(
        cmdDelete(['i-nonexistent'])
      ).rejects.toThrow('process.exit(1)')

      const errorJson = JSON.parse(errorOutput.join(''))
      expect(errorJson.error).toContain('Node not found')
    })
  })

  // ==========================================================================
  // JSON output formatting
  // ==========================================================================

  describe('output formatting', () => {
    it('should output pretty-printed JSON to stdout', async () => {
      mockClient.getNode.mockResolvedValueOnce({ id: 's-1', title: 'Test' })

      await cmdGet(['s-1'])

      // runToolCommand uses JSON.stringify with 2-space indent
      const raw = logOutput.join('')
      expect(raw).toContain('{\n')
      expect(raw).toContain('"id": "s-1"')
    })

    it('should output error JSON to stderr on RPC failure', async () => {
      mockClient.getNode.mockRejectedValueOnce(new Error('Timeout'))

      await expect(cmdGet(['s-1'])).rejects.toThrow('process.exit(1)')

      const errorJson = JSON.parse(errorOutput.join(''))
      expect(errorJson).toEqual({ error: 'Timeout' })
    })
  })
})
