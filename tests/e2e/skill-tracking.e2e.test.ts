/**
 * E2E Tests: Skill Tracking
 *
 * Verifies that skill usage is tracked during agent sessions/trajectories.
 * Tests the full flow: tool calls with _sessionId → tracking.skills queries → CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  withE2ESystem,
  type E2ESystemContext,
} from './helpers/index.js'
import type { SkillUsageSummary } from '../../src/tracking/index.js'

describe.skipIf(!AGENT_TESTS)('E2E Skill Tracking', () => {
  describe('Basic Skill Tracking', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'skill-tracking',
        enableSkillTracking: true,
      })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should track link invocations with _sessionId', async () => {
      // Create two nodes to link
      const ctx = await system.nativeProvider.create({
        type: 'context',
        title: 'Spec A',
      })
      const task = await system.nativeProvider.create({
        type: 'task',
        title: 'Task 1',
        status: 'open',
      })

      // Make a link call with _sessionId for tracking
      const linkResult = await system.client.call('tools.link', {
        fromId: ctx.id,
        toId: task.id,
        type: 'implements',
        _sessionId: 'test-session-1',
        _agentId: 'test-agent',
      })
      expect(linkResult).toHaveProperty('success', true)

      // Query skill usage for this session
      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'test-session-1' },
      )

      expect(summary).not.toBeNull()
      expect(summary!.sessionId).toBe('test-session-1')
      expect(summary!.totalInvocations).toBe(1)
      expect(summary!.skillsUsed).toContain('link')
      expect(summary!.stats).toHaveLength(1)
      expect(summary!.stats[0].skill).toBe('link')
      expect(summary!.stats[0].count).toBe(1)
      expect(summary!.stats[0].successCount).toBe(1)
      expect(summary!.stats[0].failureCount).toBe(0)
    })

    it('should track query invocations', async () => {
      // Make several query calls with _sessionId
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'test-session-2',
        _agentId: 'query-agent',
      })

      await system.client.call('tools.query', {
        nodes: {},
        _sessionId: 'test-session-2',
      })

      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'test-session-2' },
      )

      expect(summary).not.toBeNull()
      expect(summary!.totalInvocations).toBe(2)
      expect(summary!.skillsUsed).toEqual(['query'])
      expect(summary!.stats[0].count).toBe(2)
      expect(summary!.stats[0].operations).toContain('ready')
      expect(summary!.stats[0].operations).toContain('nodes')
    })

    it('should track multiple skill types in a single session', async () => {
      // Create a node to work with
      const task = await system.nativeProvider.create({
        type: 'task',
        title: 'Multi-skill Task',
        status: 'open',
      })

      const sessionId = 'multi-skill-session'

      // Query
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: sessionId,
      })

      // Link
      const ctx = await system.nativeProvider.create({
        type: 'context',
        title: 'Linked Spec',
      })
      await system.client.call('tools.link', {
        fromId: ctx.id,
        toId: task.id,
        type: 'implements',
        _sessionId: sessionId,
      })

      // Annotate
      await system.client.call('tools.annotate', {
        targetId: task.id,
        create: { content: 'Needs review', severity: 'info' },
        _sessionId: sessionId,
      })

      // Another query
      await system.client.call('tools.query', {
        feedback: { targetId: task.id },
        _sessionId: sessionId,
      })

      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId },
      )

      expect(summary).not.toBeNull()
      expect(summary!.totalInvocations).toBe(4)
      expect(summary!.skillsUsed).toHaveLength(3)
      expect(summary!.skillsUsed).toContain('query')
      expect(summary!.skillsUsed).toContain('link')
      expect(summary!.skillsUsed).toContain('annotate')

      // Check per-skill stats
      const queryStats = summary!.stats.find(s => s.skill === 'query')
      expect(queryStats).toBeDefined()
      expect(queryStats!.count).toBe(2)

      const linkStats = summary!.stats.find(s => s.skill === 'link')
      expect(linkStats).toBeDefined()
      expect(linkStats!.count).toBe(1)

      const annotateStats = summary!.stats.find(s => s.skill === 'annotate')
      expect(annotateStats).toBeDefined()
      expect(annotateStats!.count).toBe(1)
    })

    it('should isolate tracking between sessions', async () => {
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'session-a',
      })

      await system.client.call('tools.query', {
        nodes: {},
        _sessionId: 'session-b',
      })

      await system.client.call('tools.query', {
        blockers: { id: 'fake-id' },
        _sessionId: 'session-a',
      })

      const summaryA = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'session-a' },
      )
      const summaryB = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'session-b' },
      )

      expect(summaryA!.totalInvocations).toBe(2)
      expect(summaryB!.totalInvocations).toBe(1)
    })

    it('should not track invocations without _sessionId', async () => {
      // Make a query without _sessionId
      await system.client.call('tools.query', {
        ready: {},
      })

      // All summaries should be empty
      const allSummaries = await system.client.call<SkillUsageSummary[]>(
        'tracking.skills.all',
        {},
      )
      expect(allSummaries).toHaveLength(0)
    })
  })

  describe('Session Lifecycle', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'skill-lifecycle',
        enableSkillTracking: true,
      })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should return all active session summaries', async () => {
      // Create activity in multiple sessions
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'active-1',
      })
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'active-2',
      })
      await system.client.call('tools.query', {
        nodes: {},
        _sessionId: 'active-3',
      })

      const allSummaries = await system.client.call<SkillUsageSummary[]>(
        'tracking.skills.all',
        {},
      )

      expect(allSummaries).toHaveLength(3)
      const sessionIds = allSummaries.map(s => s.sessionId).sort()
      expect(sessionIds).toEqual(['active-1', 'active-2', 'active-3'])
    })

    it('should end tracking and return final summary', async () => {
      const sessionId = 'ending-session'

      // Record some activity
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: sessionId,
      })
      await system.client.call('tools.query', {
        nodes: {},
        _sessionId: sessionId,
      })

      // End tracking
      const finalSummary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills.end',
        { sessionId },
      )

      expect(finalSummary).not.toBeNull()
      expect(finalSummary!.sessionId).toBe(sessionId)
      expect(finalSummary!.totalInvocations).toBe(2)

      // After ending, the session should no longer be tracked
      const afterEnd = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId },
      )
      expect(afterEnd).toBeNull()
    })

    it('should return null for non-existent session', async () => {
      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'does-not-exist' },
      )

      expect(summary).toBeNull()
    })

    it('should return null when ending non-existent session', async () => {
      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills.end',
        { sessionId: 'never-started' },
      )

      expect(summary).toBeNull()
    })
  })

  describe('Invocation Details', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'skill-details',
        enableSkillTracking: true,
      })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should record duration for invocations', async () => {
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'duration-session',
      })

      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'duration-session' },
      )

      expect(summary).not.toBeNull()
      expect(summary!.invocations).toHaveLength(1)
      expect(summary!.invocations[0].durationMs).toBeDefined()
      expect(typeof summary!.invocations[0].durationMs).toBe('number')
      expect(summary!.invocations[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should record timestamps for invocations', async () => {
      const before = new Date().toISOString()

      await system.client.call('tools.query', {
        nodes: {},
        _sessionId: 'timestamp-session',
      })

      const after = new Date().toISOString()

      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'timestamp-session' },
      )

      expect(summary!.invocations[0].timestamp).toBeDefined()
      expect(summary!.invocations[0].timestamp >= before).toBe(true)
      expect(summary!.invocations[0].timestamp <= after).toBe(true)
    })

    it('should record operation type for queries', async () => {
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'op-type-session',
      })

      await system.client.call('tools.query', {
        blockers: { id: 'fake' },
        _sessionId: 'op-type-session',
      })

      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'op-type-session' },
      )

      expect(summary!.invocations[0].operation).toBe('ready')
      expect(summary!.invocations[1].operation).toBe('blockers')
    })

    it('should record target node IDs for link operations', async () => {
      const ctx = await system.nativeProvider.create({
        type: 'context',
        title: 'Target Spec',
      })
      const task = await system.nativeProvider.create({
        type: 'task',
        title: 'Target Task',
        status: 'open',
      })

      await system.client.call('tools.link', {
        fromId: ctx.id,
        toId: task.id,
        type: 'implements',
        _sessionId: 'targets-session',
      })

      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'targets-session' },
      )

      expect(summary!.invocations[0].targets).toBeDefined()
      expect(summary!.invocations[0].targets).toContain(ctx.id)
      expect(summary!.invocations[0].targets).toContain(task.id)
    })

    it('should track avgDurationMs in stats', async () => {
      // Make several calls to get meaningful average
      for (let i = 0; i < 5; i++) {
        await system.client.call('tools.query', {
          ready: {},
          _sessionId: 'avg-duration-session',
        })
      }

      const summary = await system.client.call<SkillUsageSummary | null>(
        'tracking.skills',
        { sessionId: 'avg-duration-session' },
      )

      const queryStats = summary!.stats.find(s => s.skill === 'query')
      expect(queryStats).toBeDefined()
      expect(queryStats!.avgDurationMs).toBeDefined()
      expect(typeof queryStats!.avgDurationMs).toBe('number')
      expect(queryStats!.avgDurationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Disabled Skill Tracking', () => {
    it('should not track when enableSkillTracking is false', async () => {
      await withE2ESystem(
        { testName: 'skill-disabled', enableSkillTracking: false },
        async (system) => {
          // Make a call with _sessionId
          await system.client.call('tools.query', {
            ready: {},
            _sessionId: 'should-not-track',
          })

          // tracking.skills should still work but return null
          // (the RPC handler creates its own registry if none provided,
          //  but with no tracker, the sessionId won't match)
          const allSummaries = await system.client.call<SkillUsageSummary[]>(
            'tracking.skills.all',
            {},
          )
          expect(allSummaries).toHaveLength(0)
        },
      )
    })
  })

  describe('Client Convenience Methods', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'skill-client',
        enableSkillTracking: true,
      })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should use client.skillUsage() method', async () => {
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'client-test',
      })

      const summary = await system.client.skillUsage('client-test') as SkillUsageSummary | null
      expect(summary).not.toBeNull()
      expect(summary!.sessionId).toBe('client-test')
    })

    it('should use client.allSkillUsage() method', async () => {
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'all-test-1',
      })
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'all-test-2',
      })

      const all = await system.client.allSkillUsage() as SkillUsageSummary[]
      expect(all).toHaveLength(2)
    })

    it('should use client.endSkillTracking() method', async () => {
      await system.client.call('tools.query', {
        ready: {},
        _sessionId: 'end-test',
      })

      const final = await system.client.endSkillTracking('end-test') as SkillUsageSummary | null
      expect(final).not.toBeNull()
      expect(final!.totalInvocations).toBe(1)

      // Should be gone now
      const after = await system.client.skillUsage('end-test') as SkillUsageSummary | null
      expect(after).toBeNull()
    })
  })
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('E2E Skill Tracking (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
