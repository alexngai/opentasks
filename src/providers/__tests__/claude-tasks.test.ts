/**
 * Tests for Claude Tasks Provider
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createClaudeTasksProvider,
  createInMemoryTaskStore,
  type ClaudeTaskStore,
} from '../claude-tasks.js'
import type { Provider } from '../types.js'
import { ProviderError } from '../types.js'

describe('ClaudeTasksProvider', () => {
  let provider: Provider
  let taskStore: ClaudeTaskStore

  beforeEach(() => {
    taskStore = createInMemoryTaskStore()
    provider = createClaudeTasksProvider({ taskStore })
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('claude')
    })

    it('should have correct schemes', () => {
      expect(provider.schemes).toEqual(['claude', 'task'])
    })

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        read: true,
        write: true,
        search: false,
        watch: false,
        mount: true,
        feedback: false,
      })
    })
  })

  describe('parseUri', () => {
    it('should parse claude:// URIs with session', () => {
      const result = provider.parseUri('claude://session-123/42')
      expect(result).toEqual({
        scheme: 'claude',
        workspace: 'session-123',
        id: '42',
        isRelative: false,
      })
    })

    it('should parse claude:// URIs with current session', () => {
      const result = provider.parseUri('claude://current/42')
      expect(result).toEqual({
        scheme: 'claude',
        workspace: 'current',
        id: '42',
        isRelative: true,
      })
    })

    it('should parse claude:// URIs without session (defaults to current)', () => {
      const result = provider.parseUri('claude://42')
      expect(result).toEqual({
        scheme: 'claude',
        workspace: 'current',
        id: '42',
        isRelative: true,
      })
    })

    it('should parse task:// shorthand URIs', () => {
      const result = provider.parseUri('task://42')
      expect(result).toEqual({
        scheme: 'task',
        workspace: 'current',
        id: '42',
        isRelative: true,
      })
    })

    it('should parse task:// URIs with session', () => {
      const result = provider.parseUri('task://my-session/42')
      expect(result).toEqual({
        scheme: 'task',
        workspace: 'my-session',
        id: '42',
        isRelative: false,
      })
    })

    it('should parse bare numeric task IDs', () => {
      const result = provider.parseUri('42')
      expect(result).toEqual({
        scheme: 'claude',
        workspace: 'current',
        id: '42',
        isRelative: true,
      })
    })

    it('should parse t- prefixed task IDs', () => {
      const result = provider.parseUri('t-42')
      expect(result).toEqual({
        scheme: 'claude',
        workspace: 'current',
        id: '42',
        isRelative: true,
      })
    })

    it('should be case-insensitive for schemes', () => {
      expect(provider.parseUri('CLAUDE://current/42')).toMatchObject({
        scheme: 'claude',
        id: '42',
      })
      expect(provider.parseUri('TASK://current/42')).toMatchObject({
        scheme: 'task',
        id: '42',
      })
    })

    it('should return null for unknown schemes', () => {
      expect(provider.parseUri('native://s-abc1')).toBeNull()
      expect(provider.parseUri('beads://bd-123')).toBeNull()
    })

    it('should return null for invalid IDs', () => {
      expect(provider.parseUri('invalid')).toBeNull()
      expect(provider.parseUri('s-abc1')).toBeNull()
    })
  })

  describe('buildUri', () => {
    it('should build full URIs with default session', () => {
      expect(provider.buildUri('42')).toBe('claude://current/42')
    })

    it('should build full URIs with custom session', () => {
      expect(provider.buildUri('42', { workspace: 'session-123' })).toBe(
        'claude://session-123/42'
      )
    })

    it('should build relative URIs when requested', () => {
      expect(provider.buildUri('42', { relative: true })).toBe('42')
    })
  })

  describe('isValidUri', () => {
    it('should return true for valid URIs', () => {
      expect(provider.isValidUri('claude://current/42')).toBe(true)
      expect(provider.isValidUri('task://42')).toBe(true)
      expect(provider.isValidUri('42')).toBe(true)
      expect(provider.isValidUri('t-42')).toBe(true)
    })

    it('should return false for invalid URIs', () => {
      expect(provider.isValidUri('native://s-abc1')).toBe(false)
      expect(provider.isValidUri('invalid')).toBe(false)
    })
  })

  describe('CRUD operations', () => {
    describe('create', () => {
      it('should create a task', async () => {
        const result = await provider.create({
          type: 'issue',
          title: 'Test Task',
          content: 'Task description',
        })

        expect(result).toMatchObject({
          type: 'task',
          title: 'Test Task',
          content: 'Task description',
          status: 'open',
        })
        expect(result.id).toBeDefined()
        expect(result.uri).toContain('claude://current/')
      })

      it('should create a task with status', async () => {
        const result = await provider.create({
          type: 'issue',
          title: 'In Progress Task',
          status: 'in_progress',
        })

        expect(result.status).toBe('in_progress')
      })

      it('should map closed status to completed', async () => {
        const result = await provider.create({
          type: 'issue',
          title: 'Done Task',
          status: 'closed',
        })

        expect(result.status).toBe('closed')
      })
    })

    describe('get', () => {
      it('should get a task by ID', async () => {
        const created = await provider.create({
          type: 'issue',
          title: 'Test Task',
        })

        const result = await provider.get(created.id)

        expect(result).toMatchObject({
          id: created.id,
          title: 'Test Task',
          type: 'task',
        })
      })

      it('should get a task by full URI', async () => {
        const created = await provider.create({
          type: 'issue',
          title: 'Test Task',
        })

        const result = await provider.get(created.uri)

        expect(result).not.toBeNull()
        expect(result?.id).toBe(created.id)
      })

      it('should return null for non-existent task', async () => {
        const result = await provider.get('999')

        expect(result).toBeNull()
      })
    })

    describe('list', () => {
      it('should list all tasks', async () => {
        await provider.create({ type: 'issue', title: 'Task 1' })
        await provider.create({ type: 'issue', title: 'Task 2' })
        await provider.create({ type: 'issue', title: 'Task 3' })

        const result = await provider.list()

        expect(result).toHaveLength(3)
      })

      it('should list tasks with status filter', async () => {
        await provider.create({ type: 'issue', title: 'Open Task', status: 'open' })
        await provider.create({
          type: 'issue',
          title: 'In Progress Task',
          status: 'in_progress',
        })
        await provider.create({ type: 'issue', title: 'Closed Task', status: 'closed' })

        const openTasks = await provider.list({ status: 'open' })
        expect(openTasks).toHaveLength(1)
        expect(openTasks[0].title).toBe('Open Task')

        const inProgressTasks = await provider.list({ status: 'in_progress' })
        expect(inProgressTasks).toHaveLength(1)
        expect(inProgressTasks[0].title).toBe('In Progress Task')
      })

      it('should list tasks with limit', async () => {
        await provider.create({ type: 'issue', title: 'Task 1' })
        await provider.create({ type: 'issue', title: 'Task 2' })
        await provider.create({ type: 'issue', title: 'Task 3' })

        const result = await provider.list({ limit: 2 })

        expect(result).toHaveLength(2)
      })
    })

    describe('update', () => {
      it('should update a task', async () => {
        const created = await provider.create({
          type: 'issue',
          title: 'Original Title',
        })

        const result = await provider.update(created.id, {
          title: 'Updated Title',
        })

        expect(result.title).toBe('Updated Title')
      })

      it('should update task status', async () => {
        const created = await provider.create({
          type: 'issue',
          title: 'Task',
          status: 'open',
        })

        const result = await provider.update(created.id, {
          status: 'in_progress',
        })

        expect(result.status).toBe('in_progress')
      })

      it('should update task by full URI', async () => {
        const created = await provider.create({
          type: 'issue',
          title: 'Task',
        })

        const result = await provider.update(created.uri, {
          title: 'Updated via URI',
        })

        expect(result.title).toBe('Updated via URI')
      })

      it('should throw for non-existent task', async () => {
        await expect(
          provider.update('999', { title: 'Updated' })
        ).rejects.toThrow(ProviderError)
      })
    })

    describe('delete', () => {
      it('should delete a task', async () => {
        const created = await provider.create({
          type: 'issue',
          title: 'Task to delete',
        })

        await provider.delete(created.id)

        const result = await provider.get(created.id)
        expect(result).toBeNull()
      })

      it('should delete task by full URI', async () => {
        const created = await provider.create({
          type: 'issue',
          title: 'Task to delete',
        })

        await provider.delete(created.uri)

        const result = await provider.get(created.id)
        expect(result).toBeNull()
      })

      it('should throw for non-existent task', async () => {
        await expect(provider.delete('999')).rejects.toThrow(ProviderError)
      })
    })
  })

  describe('node conversion', () => {
    it('should include rawData with task details', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'Test Task',
        content: 'Description',
        metadata: { custom: 'data' },
      })

      const result = await provider.get(created.id)

      expect(result?.rawData).toMatchObject({
        subject: 'Test Task',
        description: 'Description',
      })
    })

    it('should set default priority', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'Test Task',
      })

      const result = await provider.get(created.id)

      expect(result?.priority).toBe(2)
    })

    it('should include fetchedAt timestamp', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'Test Task',
      })

      const result = await provider.get(created.id)

      expect(result?.fetchedAt).toBeDefined()
      expect(new Date(result!.fetchedAt).getTime()).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('status mapping', () => {
    it('should map pending to open', async () => {
      await taskStore.create({
        subject: 'Pending Task',
        status: 'pending',
      })

      const tasks = await provider.list()
      expect(tasks[0].status).toBe('open')
    })

    it('should map in_progress to in_progress', async () => {
      await taskStore.create({
        subject: 'In Progress Task',
        status: 'in_progress',
      })

      const tasks = await provider.list()
      expect(tasks[0].status).toBe('in_progress')
    })

    it('should map completed to closed', async () => {
      await taskStore.create({
        subject: 'Completed Task',
        status: 'completed',
      })

      const tasks = await provider.list()
      expect(tasks[0].status).toBe('closed')
    })
  })

  describe('configuration', () => {
    it('should use custom session', async () => {
      const customProvider = createClaudeTasksProvider({
        session: 'my-session',
        taskStore,
      })

      const created = await customProvider.create({
        type: 'issue',
        title: 'Task',
      })

      expect(created.uri).toBe(`claude://my-session/${created.id}`)
    })
  })

  describe('in-memory task store', () => {
    it('should create unique IDs', async () => {
      const task1 = await taskStore.create({ subject: 'Task 1', status: 'pending' })
      const task2 = await taskStore.create({ subject: 'Task 2', status: 'pending' })

      expect(task1.id).not.toBe(task2.id)
    })

    it('should persist tasks', async () => {
      const created = await taskStore.create({ subject: 'Task', status: 'pending' })
      const fetched = await taskStore.get(created.id)

      expect(fetched).toEqual(created)
    })

    it('should list all tasks', async () => {
      await taskStore.create({ subject: 'Task 1', status: 'pending' })
      await taskStore.create({ subject: 'Task 2', status: 'pending' })

      const tasks = await taskStore.list()
      expect(tasks).toHaveLength(2)
    })

    it('should update tasks', async () => {
      const created = await taskStore.create({ subject: 'Original', status: 'pending' })
      const updated = await taskStore.update(created.id, { subject: 'Updated' })

      expect(updated.subject).toBe('Updated')
      expect(updated.id).toBe(created.id)
    })

    it('should delete tasks', async () => {
      const created = await taskStore.create({ subject: 'Task', status: 'pending' })
      await taskStore.delete(created.id)

      const fetched = await taskStore.get(created.id)
      expect(fetched).toBeNull()
    })
  })
})
