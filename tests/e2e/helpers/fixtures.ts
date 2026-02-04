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
 * Create a test spec with a unique name
 *
 * @param agent - TestAgent with provider configured
 * @param name - Optional name suffix
 * @param options - Optional additional spec options
 * @returns Created ProviderNode
 *
 * @example
 * ```typescript
 * const spec = await createTestSpec(agent, 'Auth Feature')
 * // Creates spec titled "Spec: Auth Feature (1706536800000-1)"
 * ```
 */
export async function createTestSpec(
  agent: TestAgent,
  name?: string,
  options?: { content?: string; priority?: number }
): Promise<ProviderNode> {
  return agent.createSpec(uniqueName('Spec', name), options)
}

/**
 * Create a test issue with a unique name
 *
 * @param agent - TestAgent with provider configured
 * @param name - Optional name suffix
 * @param options - Optional additional issue options
 * @returns Created ProviderNode
 *
 * @example
 * ```typescript
 * const issue = await createTestIssue(agent, 'Implement login')
 * // Creates issue titled "Issue: Implement login (1706536800000-2)"
 * ```
 */
export async function createTestIssue(
  agent: TestAgent,
  name?: string,
  options?: { description?: string; status?: string; priority?: number }
): Promise<ProviderNode> {
  return agent.createIssue(uniqueName('Issue', name), options)
}

/**
 * Create a chain of blocking issues: A blocks B blocks C...
 *
 * @param agent - TestAgent with provider configured
 * @param count - Number of issues in the chain
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

  const issues: ProviderNode[] = []

  // Create all issues first
  for (let i = 0; i < count; i++) {
    const issue = await createTestIssue(agent, `Chain ${i + 1}`)
    issues.push(issue)
  }

  // Create blocking edges: 0 blocks 1, 1 blocks 2, etc.
  for (let i = 0; i < count - 1; i++) {
    await agent.blocks(issues[i].id, issues[i + 1].id)
  }

  return issues
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
  const top = await createTestIssue(agent, 'Diamond Top')
  const left = await createTestIssue(agent, 'Diamond Left')
  const right = await createTestIssue(agent, 'Diamond Right')
  const bottom = await createTestIssue(agent, 'Diamond Bottom')

  // Create edges
  await agent.blocks(top.id, left.id)
  await agent.blocks(top.id, right.id)
  await agent.blocks(left.id, bottom.id)
  await agent.blocks(right.id, bottom.id)

  return { top, left, right, bottom }
}

/**
 * Spec with implementing issues result
 */
export interface SpecWithIssues {
  /** The parent spec */
  spec: ProviderNode
  /** Issues implementing the spec */
  issues: ProviderNode[]
}

/**
 * Create a spec with multiple implementing issues
 *
 * @param agent - TestAgent with provider configured
 * @param issueCount - Number of implementing issues to create
 * @param specName - Optional name for the spec
 * @returns Object with spec and issues array
 *
 * @example
 * ```typescript
 * const { spec, issues } = await createSpecWithIssues(agent, 3, 'Auth')
 * // Creates a spec and 3 issues, each linked with 'implements' edge
 * ```
 */
export async function createSpecWithIssues(
  agent: TestAgent,
  issueCount: number,
  specName?: string
): Promise<SpecWithIssues> {
  const spec = await createTestSpec(agent, specName)
  const issues: ProviderNode[] = []

  for (let i = 0; i < issueCount; i++) {
    const issue = await createTestIssue(agent, `Impl ${i + 1}`)
    await agent.implements(issue.id, spec.id)
    issues.push(issue)
  }

  return { spec, issues }
}

/**
 * Create an issue blocked by multiple other issues
 *
 * @param agent - TestAgent with provider configured
 * @param blockerCount - Number of blocking issues to create
 * @param blockedName - Optional name for the blocked issue
 * @returns Object with blocked issue and array of blockers
 *
 * @example
 * ```typescript
 * const { blocked, blockers } = await createBlockedIssue(agent, 2)
 * // Creates one issue blocked by 2 other issues
 * ```
 */
export async function createBlockedIssue(
  agent: TestAgent,
  blockerCount: number,
  blockedName?: string
): Promise<{ blocked: ProviderNode; blockers: ProviderNode[] }> {
  const blocked = await createTestIssue(agent, blockedName ?? 'Blocked Issue')
  const blockers: ProviderNode[] = []

  for (let i = 0; i < blockerCount; i++) {
    const blocker = await createTestIssue(agent, `Blocker ${i + 1}`)
    await agent.blocks(blocker.id, blocked.id)
    blockers.push(blocker)
  }

  return { blocked, blockers }
}
