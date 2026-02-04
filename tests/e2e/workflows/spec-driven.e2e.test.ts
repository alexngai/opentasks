/**
 * Spec-Driven Development Workflow E2E Tests
 *
 * Tests the core workflow: spec → issue → implement → close
 * This is the fundamental pattern for how agents use OpenTasks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  createTestAgent,
  // Assertions
  expectReady,
  expectNotReady,
  // Fixtures
  createTestSpec,
  createTestIssue,
  createSpecWithIssues,
  resetFixtureCounter,
  type E2ESystemContext,
  type TestAgent,
} from '../helpers/index.js'

describe.skipIf(!AGENT_TESTS)('Spec-Driven Development Workflow', () => {
  let system: E2ESystemContext
  let agent: TestAgent

  beforeEach(async () => {
    system = await setupE2ESystem({ testName: 'spec-driven' })
    agent = createTestAgent(system.client, {
      name: 'spec-agent',
      provider: system.nativeProvider,
    })
    resetFixtureCounter()
  })

  afterEach(async () => {
    await system.stop()
  })

  describe('Basic Spec→Issue Workflow', () => {
    it('should complete full spec→issue→close cycle', async () => {
      // 1. Create spec with title and content
      const spec = await agent.createSpec('Authentication Feature', {
        content: 'Implement OAuth2 login flow with Google provider',
        priority: 1,
      })
      expect(spec.id).toMatch(/^s-/)
      expect(spec.title).toBe('Authentication Feature')

      // 2. Create issue
      const issue = await agent.createIssue('Implement OAuth2 flow')
      expect(issue.id).toMatch(/^i-/)
      expect(issue.status).toBe('open')

      // 3. Link issue to spec with 'implements'
      const linkResult = await agent.implements(issue.id, spec.id)
      expect(linkResult.success).toBe(true)
      expect(linkResult.edge_id).toBeDefined()

      // 4. Query ready → issue appears
      await expectReady(agent, issue.id)

      // 5. Close issue
      const closed = await agent.closeIssue(issue.id)
      expect(closed.status).toBe('closed')

      // 6. Query ready → issue gone (closed issues not in ready queue)
      await expectNotReady(agent, issue.id)
    })

    it('should handle standalone issue without spec', async () => {
      // Create issue without implements link
      const issue = await agent.createIssue('Quick bug fix')

      // Verify in ready queue
      await expectReady(agent, issue.id)

      // Close and verify removal
      await agent.closeIssue(issue.id)
      await expectNotReady(agent, issue.id)
    })
  })

  describe('Multiple Issues per Spec', () => {
    it('should handle multiple issues implementing one spec', async () => {
      // Create spec
      const spec = await createTestSpec(agent, 'Feature Spec')

      // Create 3 issues implementing the spec
      const issues = []
      for (let i = 1; i <= 3; i++) {
        const issue = await createTestIssue(agent, `Task ${i}`)
        await agent.implements(issue.id, spec.id)
        issues.push(issue)
      }

      // Verify all 3 in ready queue
      for (const issue of issues) {
        await expectReady(agent, issue.id)
      }

      // Close one by one, verify queue shrinks
      await agent.closeIssue(issues[0].id)
      await expectNotReady(agent, issues[0].id)
      await expectReady(agent, issues[1].id)
      await expectReady(agent, issues[2].id)

      await agent.closeIssue(issues[1].id)
      await expectNotReady(agent, issues[1].id)
      await expectReady(agent, issues[2].id)

      await agent.closeIssue(issues[2].id)
      await expectNotReady(agent, issues[2].id)
    })

    it('should create spec with issues using fixture helper', async () => {
      const { spec, issues } = await createSpecWithIssues(agent, 3, 'Multi-issue Feature')

      expect(spec.title).toContain('Multi-issue Feature')
      expect(issues).toHaveLength(3)

      // All issues should be ready
      for (const issue of issues) {
        await expectReady(agent, issue.id)
      }
    })
  })

  describe('Issue Status Filtering', () => {
    it('should query issues by status', async () => {
      // Create multiple issues with different statuses
      const openIssue = await agent.createIssue('Open Task', { status: 'open' })
      const inProgressIssue = await agent.createIssue('In Progress Task', { status: 'in_progress' })
      const closedIssue = await agent.createIssue('Closed Task', { status: 'open' })
      await agent.closeIssue(closedIssue.id)

      // Query ready - returns only 'open' status issues (not in_progress or closed)
      const ready = await agent.ready()
      const readyIds = ready.map(r => r.id)

      expect(readyIds).toContain(openIssue.id)
      // Note: in_progress issues are NOT in the ready queue - they're being worked on
      expect(readyIds).not.toContain(inProgressIssue.id)
      expect(readyIds).not.toContain(closedIssue.id)
    })

    it('should track issue status changes', async () => {
      const issue = await agent.createIssue('Status Test')

      // Initial status
      let node = await agent.getNode(issue.id)
      expect(node?.status).toBe('open')

      // Update to in_progress
      await agent.updateNode(issue.id, { status: 'in_progress' })
      node = await agent.getNode(issue.id)
      expect(node?.status).toBe('in_progress')

      // Update to closed
      await agent.closeIssue(issue.id)
      node = await agent.getNode(issue.id)
      expect(node?.status).toBe('closed')
    })
  })

  describe('Issue Priority', () => {
    it('should store and retrieve issues with different priorities', async () => {
      // Create issues with different priorities (0 = highest, 4 = lowest)
      const lowPriority = await agent.createIssue('Low Priority', { priority: 4 })
      const highPriority = await agent.createIssue('High Priority', { priority: 0 })
      const medPriority = await agent.createIssue('Medium Priority', { priority: 2 })

      // Query ready - all issues should be included
      const ready = await agent.ready()
      const readyIds = ready.map(r => r.id)

      expect(readyIds).toContain(lowPriority.id)
      expect(readyIds).toContain(highPriority.id)
      expect(readyIds).toContain(medPriority.id)

      // Verify priorities are preserved on retrieval
      const low = ready.find(r => r.id === lowPriority.id)
      const high = ready.find(r => r.id === highPriority.id)
      const med = ready.find(r => r.id === medPriority.id)

      expect(low?.priority).toBe(4)
      expect(high?.priority).toBe(0)
      expect(med?.priority).toBe(2)
    })

    it('should update issue priority', async () => {
      const issue = await agent.createIssue('Priority Test', { priority: 2 })
      expect(issue.priority).toBe(2)

      // Update priority
      const updated = await agent.updateNode(issue.id, { priority: 0 })
      expect(updated.priority).toBe(0)
    })
  })

  describe('Spec Content and Metadata', () => {
    it('should preserve spec content through retrieval', async () => {
      const content = `
## Overview
This is a detailed specification.

## Requirements
- Requirement 1
- Requirement 2

## Acceptance Criteria
- [ ] Criteria 1
- [ ] Criteria 2
      `.trim()

      const spec = await agent.createSpec('Detailed Spec', { content })
      const retrieved = await agent.getNode(spec.id)

      expect(retrieved?.content).toBe(content)
    })

    it('should update spec content', async () => {
      const spec = await agent.createSpec('Editable Spec', {
        content: 'Initial content',
      })

      const updated = await agent.updateNode(spec.id, {
        content: 'Updated content with more details',
      })

      expect(updated.content).toBe('Updated content with more details')
    })
  })
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('Spec-Driven Development Workflow (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
