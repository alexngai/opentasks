import { describe, it, expect } from 'vitest';
import { isTaskManageable, type TaskManageable, type TaskAction } from '../TaskManageable.js';
import type { Provider, ProviderNode } from '../../types.js';

// Mock provider that doesn't implement TaskManageable
const mockBasicProvider: Provider = {
  name: 'basic',
  schemes: ['basic'],
  capabilities: {
    read: true,
    write: false,
    search: false,
    watch: false,
    mount: false,
    feedback: false,
  },
  parseUri: () => null,
  buildUri: (id) => `basic://${id}`,
  isValidUri: () => false,
  get: async () => null,
  list: async () => [],
  create: async () => ({}) as ProviderNode,
  update: async () => ({}) as ProviderNode,
  delete: async () => {},
};

// Mock task-capable provider
const mockTaskProvider: Provider & TaskManageable = {
  name: 'tasks',
  schemes: ['tasks'],
  capabilities: {
    read: true,
    write: true,
    search: false,
    watch: false,
    mount: true,
    feedback: false,
  },
  parseUri: (uri) => {
    if (uri.startsWith('tasks://')) {
      return { scheme: 'tasks', id: uri.slice(8), isRelative: false };
    }
    return null;
  },
  buildUri: (id) => `tasks://${id}`,
  isValidUri: (uri) => uri.startsWith('tasks://'),
  get: async () => null,
  list: async () => [],
  create: async () => ({}) as ProviderNode,
  update: async () => ({}) as ProviderNode,
  delete: async () => {},

  taskCapabilities: {
    actions: ['start', 'complete', 'block', 'reopen'],
    supportsAssignment: true,
    supportsReadyQuery: true,
    statusModel: ['open', 'in_progress', 'blocked', 'done'],
  },

  transitionTask: async (id: string, action: TaskAction): Promise<ProviderNode> => {
    const statusMap: Record<TaskAction, string> = {
      start: 'in_progress',
      complete: 'done',
      block: 'blocked',
      reopen: 'open',
      close: 'done',
    };
    return {
      id,
      uri: `tasks://${id}`,
      type: 'issue',
      title: `Task ${id}`,
      status: statusMap[action],
      fetchedAt: new Date().toISOString(),
    };
  },

  readyTasks: async (options): Promise<ProviderNode[]> => {
    const tasks: ProviderNode[] = [
      {
        id: 'task-1',
        uri: 'tasks://task-1',
        type: 'issue',
        title: 'Ready 1',
        status: 'open',
        fetchedAt: new Date().toISOString(),
      },
      {
        id: 'task-2',
        uri: 'tasks://task-2',
        type: 'issue',
        title: 'Ready 2',
        status: 'open',
        priority: 1,
        fetchedAt: new Date().toISOString(),
      },
      {
        id: 'task-3',
        uri: 'tasks://task-3',
        type: 'issue',
        title: 'Ready 3',
        status: 'open',
        priority: 2,
        fetchedAt: new Date().toISOString(),
      },
    ];
    const limit = options?.limit ?? tasks.length;
    return tasks.slice(0, limit);
  },

  assignTask: async (id: string, assignee: string): Promise<ProviderNode> => {
    return {
      id,
      uri: `tasks://${id}`,
      type: 'issue',
      title: `Task ${id}`,
      status: 'open',
      rawData: { assignee },
      fetchedAt: new Date().toISOString(),
    };
  },

  validActions: async (_id: string): Promise<TaskAction[]> => {
    // Simulate: open tasks can be started or closed
    return ['start', 'close'];
  },
};

describe('isTaskManageable', () => {
  it('returns false for providers without task methods', () => {
    expect(isTaskManageable(mockBasicProvider)).toBe(false);
  });

  it('returns true for providers with transitionTask, readyTasks, and taskCapabilities', () => {
    expect(isTaskManageable(mockTaskProvider)).toBe(true);
  });

  it('returns false for providers with only transitionTask', () => {
    const partialProvider = {
      ...mockBasicProvider,
      transitionTask: async () => ({}) as ProviderNode,
    };
    expect(isTaskManageable(partialProvider as Provider)).toBe(false);
  });

  it('returns false for providers with only readyTasks', () => {
    const partialProvider = {
      ...mockBasicProvider,
      readyTasks: async () => [],
    };
    expect(isTaskManageable(partialProvider as Provider)).toBe(false);
  });

  it('returns false for providers with methods but no taskCapabilities', () => {
    const partialProvider = {
      ...mockBasicProvider,
      transitionTask: async () => ({}) as ProviderNode,
      readyTasks: async () => [],
    };
    expect(isTaskManageable(partialProvider as Provider)).toBe(false);
  });

  it('returns true even without optional methods (assignTask, validActions)', () => {
    const minimalTaskProvider = {
      ...mockBasicProvider,
      taskCapabilities: {
        actions: ['start', 'complete'] as TaskAction[],
        supportsAssignment: false,
        supportsReadyQuery: true,
        statusModel: ['open', 'done'],
      },
      transitionTask: async () => ({}) as ProviderNode,
      readyTasks: async () => [],
    };
    expect(isTaskManageable(minimalTaskProvider as Provider)).toBe(true);
  });
});

describe('TaskManageable implementation', () => {
  it('transitions a task with start action', async () => {
    const result = await mockTaskProvider.transitionTask('task-1', 'start');
    expect(result.status).toBe('in_progress');
    expect(result.id).toBe('task-1');
  });

  it('transitions a task with complete action', async () => {
    const result = await mockTaskProvider.transitionTask('task-1', 'complete');
    expect(result.status).toBe('done');
  });

  it('transitions a task with block action', async () => {
    const result = await mockTaskProvider.transitionTask('task-1', 'block');
    expect(result.status).toBe('blocked');
  });

  it('transitions a task with reopen action', async () => {
    const result = await mockTaskProvider.transitionTask('task-1', 'reopen');
    expect(result.status).toBe('open');
  });

  it('returns ready tasks', async () => {
    const ready = await mockTaskProvider.readyTasks();
    expect(ready).toHaveLength(3);
    expect(ready[0].title).toBe('Ready 1');
  });

  it('returns ready tasks with limit', async () => {
    const ready = await mockTaskProvider.readyTasks({ limit: 2 });
    expect(ready).toHaveLength(2);
  });

  it('assigns a task', async () => {
    const result = await mockTaskProvider.assignTask!('task-1', 'alice');
    expect(result.rawData?.assignee).toBe('alice');
  });

  it('returns valid actions for a task', async () => {
    const actions = await mockTaskProvider.validActions!('task-1');
    expect(actions).toContain('start');
    expect(actions).toContain('close');
    expect(actions).not.toContain('complete');
  });

  it('exposes task capabilities', () => {
    expect(mockTaskProvider.taskCapabilities.actions).toContain('start');
    expect(mockTaskProvider.taskCapabilities.actions).toContain('complete');
    expect(mockTaskProvider.taskCapabilities.supportsAssignment).toBe(true);
    expect(mockTaskProvider.taskCapabilities.supportsReadyQuery).toBe(true);
    expect(mockTaskProvider.taskCapabilities.statusModel).toEqual([
      'open',
      'in_progress',
      'blocked',
      'done',
    ]);
  });
});
