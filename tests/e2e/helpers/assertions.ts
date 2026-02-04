/**
 * E2E Test Assertions
 *
 * Reusable assertion helpers for E2E tests.
 * These provide descriptive error messages and reduce test boilerplate.
 */

import type { TestAgent } from './test-agent.js'

/**
 * Assert that an issue is in the ready queue (has no active blockers)
 *
 * @param agent - TestAgent to use for the query
 * @param issueId - Issue ID to check
 * @throws Error if issue is not in the ready queue
 */
export async function expectReady(agent: TestAgent, issueId: string): Promise<void> {
  const ready = await agent.ready()
  const found = ready.some(item => item.id === issueId)

  if (!found) {
    const readyIds = ready.map(item => item.id).join(', ') || '(none)'
    throw new Error(
      `Expected issue '${issueId}' to be ready, but it was not.\n` +
      `Ready issues: ${readyIds}`
    )
  }
}

/**
 * Assert that an issue is NOT in the ready queue
 *
 * @param agent - TestAgent to use for the query
 * @param issueId - Issue ID to check
 * @throws Error if issue is in the ready queue
 */
export async function expectNotReady(agent: TestAgent, issueId: string): Promise<void> {
  const ready = await agent.ready()
  const found = ready.some(item => item.id === issueId)

  if (found) {
    throw new Error(
      `Expected issue '${issueId}' to NOT be ready, but it was in the ready queue.`
    )
  }
}

/**
 * Assert that one node blocks another
 *
 * @param agent - TestAgent to use for the query
 * @param blockerId - ID of the blocking node
 * @param blockedId - ID of the blocked node
 * @throws Error if the blocking relationship doesn't exist
 */
export async function expectBlocks(
  agent: TestAgent,
  blockerId: string,
  blockedId: string
): Promise<void> {
  // Query what the blocker is blocking
  const blocking = await agent.blocking(blockerId)
  const found = blocking.some(item => item.id === blockedId)

  if (!found) {
    const blockingIds = blocking.map(item => item.id).join(', ') || '(none)'
    throw new Error(
      `Expected '${blockerId}' to block '${blockedId}', but it doesn't.\n` +
      `'${blockerId}' blocks: ${blockingIds}`
    )
  }
}

/**
 * Assert that an issue has specific blockers
 *
 * @param agent - TestAgent to use for the query
 * @param issueId - Issue ID to check
 * @param blockerIds - Expected blocker IDs (order doesn't matter)
 * @throws Error if blockers don't match
 */
export async function expectBlockers(
  agent: TestAgent,
  issueId: string,
  blockerIds: string[]
): Promise<void> {
  const blockers = await agent.blockers(issueId)
  const actualIds = blockers.map(b => b.id).sort()
  const expectedIds = [...blockerIds].sort()

  const missing = expectedIds.filter(id => !actualIds.includes(id))
  const extra = actualIds.filter(id => !expectedIds.includes(id))

  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) {
      parts.push(`Missing blockers: ${missing.join(', ')}`)
    }
    if (extra.length > 0) {
      parts.push(`Unexpected blockers: ${extra.join(', ')}`)
    }
    throw new Error(
      `Blockers for '${issueId}' don't match expected.\n` +
      `Expected: ${expectedIds.join(', ') || '(none)'}\n` +
      `Actual: ${actualIds.join(', ') || '(none)'}\n` +
      parts.join('\n')
    )
  }
}

/**
 * Options for expectFeedback assertion
 */
export interface ExpectFeedbackOptions {
  /** Filter by feedback type */
  type?: 'comment' | 'suggestion' | 'request'

  /** Expected count of feedback items */
  count?: number

  /** Minimum count of feedback items */
  minCount?: number
}

/**
 * Assert that feedback exists on a node
 *
 * @param agent - TestAgent to use for the query
 * @param nodeId - Node ID to check
 * @param options - Optional filters for type and count
 * @throws Error if feedback doesn't match expectations
 */
export async function expectFeedback(
  agent: TestAgent,
  nodeId: string,
  options?: ExpectFeedbackOptions
): Promise<void> {
  const feedback = await agent.feedback(nodeId, options?.type ? { type: options.type } : undefined)

  if (options?.count !== undefined && feedback.length !== options.count) {
    throw new Error(
      `Expected ${options.count} feedback items on '${nodeId}', found ${feedback.length}.`
    )
  }

  if (options?.minCount !== undefined && feedback.length < options.minCount) {
    throw new Error(
      `Expected at least ${options.minCount} feedback items on '${nodeId}', found ${feedback.length}.`
    )
  }

  if (options?.count === undefined && options?.minCount === undefined && feedback.length === 0) {
    throw new Error(
      `Expected feedback on '${nodeId}', but none was found.`
    )
  }
}

/**
 * Assert that a node has a specific status
 *
 * @param agent - TestAgent to use
 * @param nodeId - Node ID to check
 * @param expectedStatus - Expected status value
 * @throws Error if status doesn't match
 */
export async function expectStatus(
  agent: TestAgent,
  nodeId: string,
  expectedStatus: string
): Promise<void> {
  const node = await agent.getNode(nodeId)

  if (!node) {
    throw new Error(`Node '${nodeId}' not found.`)
  }

  if (node.status !== expectedStatus) {
    throw new Error(
      `Expected node '${nodeId}' to have status '${expectedStatus}', ` +
      `but it has status '${node.status}'.`
    )
  }
}

/**
 * Assert that a node exists and has expected title
 *
 * @param agent - TestAgent to use
 * @param nodeId - Node ID to check
 * @param expectedTitle - Expected title value
 * @throws Error if node doesn't exist or title doesn't match
 */
export async function expectTitle(
  agent: TestAgent,
  nodeId: string,
  expectedTitle: string
): Promise<void> {
  const node = await agent.getNode(nodeId)

  if (!node) {
    throw new Error(`Node '${nodeId}' not found.`)
  }

  if (node.title !== expectedTitle) {
    throw new Error(
      `Expected node '${nodeId}' to have title '${expectedTitle}', ` +
      `but it has title '${node.title}'.`
    )
  }
}
