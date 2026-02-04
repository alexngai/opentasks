/**
 * Feedback Loop E2E Tests
 *
 * Tests the annotate tool and feedback lifecycle.
 * Feedback enables agents to communicate about specs and issues.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  createTestAgent,
  // Assertions
  expectFeedback,
  // Fixtures
  createTestSpec,
  createTestIssue,
  resetFixtureCounter,
  type E2ESystemContext,
  type TestAgent,
} from '../helpers/index.js'

describe.skipIf(!AGENT_TESTS)('Feedback Loop', () => {
  let system: E2ESystemContext
  let agent: TestAgent

  beforeEach(async () => {
    system = await setupE2ESystem({ testName: 'feedback' })
    agent = createTestAgent(system.client, {
      name: 'feedback-agent',
      provider: system.nativeProvider,
    })
    resetFixtureCounter()
  })

  afterEach(async () => {
    await system.stop()
  })

  describe('Basic Feedback Operations', () => {
    it('should add feedback to spec', async () => {
      // Create spec
      const spec = await createTestSpec(agent, 'Auth Feature')

      // Add comment feedback via agent.addFeedback()
      const result = await agent.addFeedback(
        spec.id,
        'Consider adding OAuth2 support',
        'comment'
      )
      expect(result.success).toBe(true)
      expect(result.feedback_id).toBeDefined()

      // Query feedback on spec
      const feedback = await agent.feedback(spec.id)
      expect(feedback).toHaveLength(1)
      expect(feedback[0].content_preview).toContain('OAuth2')
      expect(feedback[0].feedback_type).toBe('comment')
      expect(feedback[0].resolved).toBe(false)
    })

    it('should add different types of feedback', async () => {
      const spec = await createTestSpec(agent, 'API Design')

      // Add comment
      await agent.addFeedback(spec.id, 'This looks good', 'comment')

      // Add suggestion
      await agent.addFeedback(spec.id, 'Consider using REST', 'suggestion')

      // Add request
      await agent.addFeedback(spec.id, 'Please add pagination', 'request')

      // Query all feedback
      const allFeedback = await agent.feedback(spec.id)
      expect(allFeedback).toHaveLength(3)

      const types = allFeedback.map(f => f.feedback_type)
      expect(types).toContain('comment')
      expect(types).toContain('suggestion')
      expect(types).toContain('request')
    })
  })

  describe('Feedback with Issue Context', () => {
    it('should track feedback from implementing issue', async () => {
      // Create spec and implementing issue
      const spec = await createTestSpec(agent, 'Feature Spec')
      const issue = await createTestIssue(agent, 'Implement Feature')

      // Link issue to spec
      await agent.implements(issue.id, spec.id)

      // Add feedback to spec with from_id=issue.id
      const result = await agent.annotate({
        target_id: spec.id,
        from_id: issue.id,
        create: {
          content: 'Found an edge case while implementing',
          type: 'comment',
        },
      })
      expect(result.success).toBe(true)

      // Query feedback on spec
      const feedback = await agent.feedback(spec.id)
      expect(feedback).toHaveLength(1)
      expect(feedback[0].content_preview).toContain('edge case')
    })
  })

  describe('Resolve and Query Feedback', () => {
    it('should resolve and query feedback', async () => {
      const spec = await createTestSpec(agent, 'Resolve Test')

      // Create 3 feedback items
      const result1 = await agent.addFeedback(spec.id, 'Feedback 1', 'comment')
      const result2 = await agent.addFeedback(spec.id, 'Feedback 2', 'comment')
      const result3 = await agent.addFeedback(spec.id, 'Feedback 3', 'comment')

      // Resolve one via agent.resolveFeedback()
      await agent.resolveFeedback(spec.id, result2.feedback_id!)

      // Query with resolved=false → 2 items
      const unresolvedFeedback = await agent.feedback(spec.id, { resolved: false })
      expect(unresolvedFeedback).toHaveLength(2)

      // Query with resolved=true → 1 item
      const resolvedFeedback = await agent.feedback(spec.id, { resolved: true })
      expect(resolvedFeedback).toHaveLength(1)
      expect(resolvedFeedback[0].id).toBe(result2.feedback_id)
    })

    it('should reopen resolved feedback', async () => {
      const spec = await createTestSpec(agent, 'Reopen Test')

      // Add and resolve feedback
      const result = await agent.addFeedback(spec.id, 'Will be resolved then reopened', 'comment')
      await agent.resolveFeedback(spec.id, result.feedback_id!)

      // Verify it's resolved
      let feedback = await agent.feedback(spec.id, { resolved: true })
      expect(feedback).toHaveLength(1)

      // Reopen it
      await agent.reopenFeedback(spec.id, result.feedback_id!)

      // Verify it's no longer resolved
      feedback = await agent.feedback(spec.id, { resolved: true })
      expect(feedback).toHaveLength(0)

      feedback = await agent.feedback(spec.id, { resolved: false })
      expect(feedback).toHaveLength(1)
    })
  })

  describe('Dismiss and Filter Feedback', () => {
    it('should dismiss and filter feedback', async () => {
      const spec = await createTestSpec(agent, 'Dismiss Test')

      // Create feedback
      const result = await agent.addFeedback(spec.id, 'Not relevant anymore', 'comment')

      // Dismiss feedback
      await agent.dismissFeedback(spec.id, result.feedback_id!)

      // Query without include_dismissed → empty
      const normalQuery = await agent.feedback(spec.id)
      expect(normalQuery).toHaveLength(0)

      // Query with include_dismissed=true → includes dismissed
      const withDismissed = await agent.feedback(spec.id, { include_dismissed: true })
      expect(withDismissed).toHaveLength(1)
      expect(withDismissed[0].dismissed).toBe(true)
    })
  })

  describe('Filter Feedback by Type', () => {
    it('should filter feedback by type', async () => {
      const spec = await createTestSpec(agent, 'Type Filter Test')

      // Add comment, suggestion, and request feedback
      await agent.addFeedback(spec.id, 'This is a comment', 'comment')
      await agent.addFeedback(spec.id, 'This is a suggestion', 'suggestion')
      await agent.addFeedback(spec.id, 'This is a request', 'request')

      // Query by type='comment' → only comment
      const comments = await agent.feedback(spec.id, { type: 'comment' })
      expect(comments).toHaveLength(1)
      expect(comments[0].feedback_type).toBe('comment')

      // Query by type='suggestion' → only suggestion
      const suggestions = await agent.feedback(spec.id, { type: 'suggestion' })
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0].feedback_type).toBe('suggestion')

      // Query by type='request' → only request
      const requests = await agent.feedback(spec.id, { type: 'request' })
      expect(requests).toHaveLength(1)
      expect(requests[0].feedback_type).toBe('request')
    })
  })

  describe('Anchored Feedback', () => {
    it('should support anchored feedback', async () => {
      // Create spec with multi-line content
      const spec = await agent.createSpec('Multi-line Spec', {
        content: `Line 1: Introduction
Line 2: Overview
Line 3: Details
Line 4: Implementation
Line 5: specific text here
Line 6: Conclusion`,
      })

      // Add feedback with anchor
      const result = await agent.annotate({
        target_id: spec.id,
        create: {
          content: 'This section needs clarification',
          type: 'suggestion',
          anchor: { line: 5, text: 'specific text' },
        },
      })
      expect(result.success).toBe(true)

      // Query feedback - anchor info should be tracked
      // Note: FeedbackSummary may not expose anchor directly,
      // but the full Feedback node stores it
      const feedback = await agent.feedback(spec.id)
      expect(feedback).toHaveLength(1)
      expect(feedback[0].content_preview).toContain('clarification')
    })
  })

  describe('Feedback on Issues', () => {
    it('should add feedback to issues', async () => {
      const issue = await createTestIssue(agent, 'Task with Feedback')

      // Add feedback to issue
      const result = await agent.addFeedback(
        issue.id,
        'Remember to add tests',
        'suggestion'
      )
      expect(result.success).toBe(true)

      // Verify feedback exists
      await expectFeedback(agent, issue.id, { count: 1 })
    })
  })

  describe('Feedback Assertion Helper', () => {
    it('should use expectFeedback assertion', async () => {
      const spec = await createTestSpec(agent, 'Assertion Test')

      // Initially no feedback
      await expectFeedback(agent, spec.id, { count: 0 })

      // Add some feedback
      await agent.addFeedback(spec.id, 'First', 'comment')
      await agent.addFeedback(spec.id, 'Second', 'comment')

      // Verify count
      await expectFeedback(agent, spec.id, { count: 2 })

      // Verify minimum
      await expectFeedback(agent, spec.id, { minCount: 1 })
    })
  })
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('Feedback Loop (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
