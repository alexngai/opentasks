/**
 * E2E Test Fixtures
 *
 * Reusable fixture helpers for creating test data.
 * These generate unique names and set up common data structures.
 */

import type { TestAgent } from './test-agent.js'
import type { ProviderNode } from '../../../src/providers/types.js'

// Counter for unique names
let fixtureCounter = 0

/**
 * Generate a unique name for a fixture
 */
function uniqueName(prefix: string, name?: string): string {
  fixtureCounter++
  const timestamp = Date.now()
  return name ? `${prefix}: ${name} (${timestamp}-${fixtureCounter})` : `${prefix} ${timestamp}-${fixtureCounter}`
}

/**
 * Reset the fixture counter (useful for test isolation)
 */
export function resetFixtureCounter(): void {
  fixtureCounter = 0
}

/**
 * Create a test context with a unique name
 *
 * @param agent - TestAgent with provider configured
 * @param name - Optional name suffix
 * @param options - Optional additional context options
 * @returns Created ProviderNode
 *
 * @example
 * ```typescript
 * const context = await createTestContext(agent, 'Auth Feature')
 * // Creates context titled "Context: Auth Feature (1706536800000-1)"
 * ```
 */
export async function createTestContext(
  agent: TestAgent,
  name?: string,
  options?: { content?: string; priority?: number }
): Promise<ProviderNode> {
  return agent.createContext(uniqueName('Context', name), options)
}

/**
 * Create a test task with a unique name
 *
 * @param agent - TestAgent with provider configured
 * @param name - Optional name suffix
 * @param options - Optional additional task options
 * @returns Created ProviderNode
 *
 * @example
 * ```typescript
 * const task = await createTestTask(agent, 'Implement login')
 * // Creates task titled "Task: Implement login (1706536800000-2)"
 * ```
 */
export async function createTestTask(
  agent: TestAgent,
  name?: string,
  options?: { description?: string; status?: string; priority?: number }
): Promise<ProviderNode> {
  return agent.createTask(uniqueName('Task', name), options)
}

/**
 * Create a chain of blocking tasks: A blocks B blocks C...
 *
 * @param agent - TestAgent with provider configured
 * @param count - Number of tasks in the chain
 * @returns Array of ProviderNodes in order [A, B, C, ...]
 *
 * @example
 * ```typescript
 * const [a, b, c] = await createBlockingChain(agent, 3)
 * // a blocks b, b blocks c
 * // Only 'a' should be ready initially
 * ```
 */
export async function createBlockingChain(
  agent: TestAgent,
  count: number
): Promise<ProviderNode[]> {
  if (count < 1) {
    throw new Error('createBlockingChain requires count >= 1')
  }

  const tasks: ProviderNode[] = []

  // Create all tasks first
  for (let i = 0; i < count; i++) {
    const task = await createTestTask(agent, `Chain ${i + 1}`)
    tasks.push(task)
  }

  // Create blocking edges: 0 blocks 1, 1 blocks 2, etc.
  for (let i = 0; i < count - 1; i++) {
    await agent.blocks(tasks[i].id, tasks[i + 1].id)
  }

  return tasks
}

/**
 * Diamond dependency result
 */
export interface DiamondDependency {
  /** Top of diamond (no blockers) */
  top: ProviderNode
  /** Left branch (blocked by top) */
  left: ProviderNode
  /** Right branch (blocked by top) */
  right: ProviderNode
  /** Bottom (blocked by left and right) */
  bottom: ProviderNode
}

/**
 * Create a diamond dependency structure
 *
 * ```
 *       top
 *      /   \
 *   left   right
 *      \   /
 *      bottom
 * ```
 *
 * @param agent - TestAgent with provider configured
 * @returns Object with top, left, right, bottom nodes
 *
 * @example
 * ```typescript
 * const { top, left, right, bottom } = await createDiamondDependency(agent)
 * // top is ready
 * // left and right are blocked by top
 * // bottom is blocked by both left and right
 * ```
 */
export async function createDiamondDependency(
  agent: TestAgent
): Promise<DiamondDependency> {
  // Create all nodes
  const top = await createTestTask(agent, 'Diamond Top')
  const left = await createTestTask(agent, 'Diamond Left')
  const right = await createTestTask(agent, 'Diamond Right')
  const bottom = await createTestTask(agent, 'Diamond Bottom')

  // Create edges
  await agent.blocks(top.id, left.id)
  await agent.blocks(top.id, right.id)
  await agent.blocks(left.id, bottom.id)
  await agent.blocks(right.id, bottom.id)

  return { top, left, right, bottom }
}

/**
 * Context with implementing tasks result
 */
export interface ContextWithTasks {
  /** The parent context */
  context: ProviderNode
  /** Tasks implementing the context */
  tasks: ProviderNode[]
}

/**
 * Create a context with multiple implementing tasks
 *
 * @param agent - TestAgent with provider configured
 * @param taskCount - Number of implementing tasks to create
 * @param contextName - Optional name for the context
 * @returns Object with context and tasks array
 *
 * @example
 * ```typescript
 * const { context, tasks } = await createContextWithTasks(agent, 3, 'Auth')
 * // Creates a context and 3 tasks, each linked with 'implements' edge
 * ```
 */
export async function createContextWithTasks(
  agent: TestAgent,
  taskCount: number,
  contextName?: string
): Promise<ContextWithTasks> {
  const context = await createTestContext(agent, contextName)
  const tasks: ProviderNode[] = []

  for (let i = 0; i < taskCount; i++) {
    const task = await createTestTask(agent, `Impl ${i + 1}`)
    await agent.implements(task.id, context.id)
    tasks.push(task)
  }

  return { context, tasks }
}

/**
 * Create a task blocked by multiple other tasks
 *
 * @param agent - TestAgent with provider configured
 * @param blockerCount - Number of blocking tasks to create
 * @param blockedName - Optional name for the blocked task
 * @returns Object with blocked task and array of blockers
 *
 * @example
 * ```typescript
 * const { blocked, blockers } = await createBlockedTask(agent, 2)
 * // Creates one task blocked by 2 other tasks
 * ```
 */
export async function createBlockedTask(
  agent: TestAgent,
  blockerCount: number,
  blockedName?: string
): Promise<{ blocked: ProviderNode; blockers: ProviderNode[] }> {
  const blocked = await createTestTask(agent, blockedName ?? 'Blocked Task')
  const blockers: ProviderNode[] = []

  for (let i = 0; i < blockerCount; i++) {
    const blocker = await createTestTask(agent, `Blocker ${i + 1}`)
    await agent.blocks(blocker.id, blocked.id)
    blockers.push(blocker)
  }

  return { blocked, blockers }
}
