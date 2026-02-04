/**
 * Test Agent for E2E Tests
 *
 * A wrapper around OpenTasksClient that simulates an agent making tool calls.
 * Provides the 3-tool interface (link, query, annotate) plus convenience methods.
 * Also supports provider operations for creating/updating nodes.
 */

import type { OpenTasksClient } from '../../../src/client/index.js'
import type {
  LinkParams,
  LinkResult,
  QueryParams,
  QueryResult,
  AnnotateParams,
  AnnotateResult,
  NodeSummary,
  FeedbackSummary,
  ReadyOptions,
  BlockerOptions,
  FeedbackOptions,
  EdgeType,
  Node,
  Edge,
} from '../../../src/tools/types.js'
import type {
  Provider,
  ProviderNode,
  ProviderUpdateInput,
} from '../../../src/providers/types.js'

/**
 * Options for creating a test agent
 */
export interface TestAgentOptions {
  /** Agent name for debugging/logging */
  name?: string

  /** Whether to log operations (default: false) */
  verbose?: boolean

  /** Provider for node CRUD operations (required for createSpec, createIssue, etc.) */
  provider?: Provider
}

/**
 * Options for creating a spec via provider
 */
export interface CreateSpecOptions {
  /** Spec content/description */
  content?: string

  /** Priority (0-4, where 0 is highest) */
  priority?: number

  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Options for creating an issue via provider
 */
export interface CreateIssueOptions {
  /** Issue description */
  description?: string

  /** Issue status (default: 'open') */
  status?: string

  /** Priority (0-4, where 0 is highest) */
  priority?: number

  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Extended link parameters for convenience
 */
export interface ExtendedLinkParams extends LinkParams {
  // Standard LinkParams fields are inherited
}

/**
 * Quick create parameters for nodes (not yet implemented in daemon)
 * Placeholder for future MCP tool integration
 */
export interface QuickCreateSpecParams {
  title: string
  content?: string
  priority?: number
  tags?: string[]
}

export interface QuickCreateIssueParams {
  title: string
  description?: string
  status?: string
  priority?: number
  tags?: string[]
  implements?: string  // Spec ID to link with 'implements' edge
  blocked_by?: string[] // Issue IDs that block this issue
}

/**
 * Test Agent Interface
 *
 * Simulates an agent interacting with OpenTasks via the 3-tool interface.
 */
export interface TestAgent {
  /** Agent name */
  readonly name: string

  /** Underlying client (for advanced operations) */
  readonly client: OpenTasksClient

  // ==========================================================================
  // Core Tools (3-tool interface)
  // ==========================================================================

  /**
   * Create or remove an edge between nodes
   */
  link(params: LinkParams): Promise<LinkResult>

  /**
   * Query the graph
   */
  query(params: QueryParams): Promise<QueryResult>

  /**
   * Manage feedback lifecycle
   */
  annotate(params: AnnotateParams): Promise<AnnotateResult>

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Get issues ready to work on (no active blockers)
   */
  ready(options?: ReadyOptions): Promise<NodeSummary[]>

  /**
   * Get nodes blocking a specific node
   */
  blockers(nodeId: string, options?: Omit<BlockerOptions, 'node_id'>): Promise<NodeSummary[]>

  /**
   * Get nodes blocked by a specific node
   */
  blocking(nodeId: string, options?: Omit<BlockerOptions, 'node_id'>): Promise<NodeSummary[]>

  /**
   * Get feedback on a specific node
   */
  feedback(nodeId: string, options?: Omit<FeedbackOptions, 'node_id'>): Promise<FeedbackSummary[]>

  /**
   * Create a 'blocks' edge (from blocks to)
   */
  blocks(fromId: string, toId: string): Promise<LinkResult>

  /**
   * Create an 'implements' edge (from implements to)
   */
  implements(issueId: string, specId: string): Promise<LinkResult>

  /**
   * Add feedback to a target node
   */
  addFeedback(
    targetId: string,
    content: string,
    type?: 'comment' | 'suggestion' | 'request'
  ): Promise<AnnotateResult>

  /**
   * Resolve feedback
   */
  resolveFeedback(targetId: string, feedbackId: string): Promise<AnnotateResult>

  /**
   * Dismiss feedback
   */
  dismissFeedback(targetId: string, feedbackId: string): Promise<AnnotateResult>

  /**
   * Reopen resolved/dismissed feedback
   */
  reopenFeedback(targetId: string, feedbackId: string): Promise<AnnotateResult>

  /**
   * Disconnect the agent's client
   */
  disconnect(): void

  // ==========================================================================
  // Provider Operations (require provider in options)
  // ==========================================================================

  /**
   * Create a spec via provider
   * @throws Error if provider not configured
   */
  createSpec(title: string, options?: CreateSpecOptions): Promise<ProviderNode>

  /**
   * Create an issue via provider
   * @throws Error if provider not configured
   */
  createIssue(title: string, options?: CreateIssueOptions): Promise<ProviderNode>

  /**
   * Update a node via provider
   * @throws Error if provider not configured
   */
  updateNode(id: string, updates: ProviderUpdateInput): Promise<ProviderNode>

  /**
   * Close an issue (convenience for updateNode with status='closed')
   * @throws Error if provider not configured
   */
  closeIssue(id: string): Promise<ProviderNode>

  /**
   * Get a node by ID via provider
   * @throws Error if provider not configured
   */
  getNode(id: string): Promise<ProviderNode | null>
}

/**
 * Test Agent Implementation
 */
class TestAgentImpl implements TestAgent {
  readonly name: string
  readonly client: OpenTasksClient
  private readonly verbose: boolean
  private readonly provider?: Provider

  constructor(client: OpenTasksClient, options: TestAgentOptions = {}) {
    this.client = client
    this.name = options.name ?? 'agent'
    this.verbose = options.verbose ?? false
    this.provider = options.provider
  }

  private requireProvider(): Provider {
    if (!this.provider) {
      throw new Error(`Agent '${this.name}' requires a provider for node operations. Pass provider in TestAgentOptions.`)
    }
    return this.provider
  }

  private log(operation: string, params?: unknown): void {
    if (this.verbose) {
      console.log(`[${this.name}] ${operation}`, params ? JSON.stringify(params) : '')
    }
  }

  // ==========================================================================
  // Core Tools
  // ==========================================================================

  async link(params: LinkParams): Promise<LinkResult> {
    this.log('link', params)
    return this.client.link(params)
  }

  async query(params: QueryParams): Promise<QueryResult> {
    this.log('query', params)
    return this.client.query(params)
  }

  async annotate(params: AnnotateParams): Promise<AnnotateResult> {
    this.log('annotate', params)
    return this.client.annotate(params)
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  async ready(options?: ReadyOptions): Promise<NodeSummary[]> {
    this.log('ready', options)
    return this.client.ready(options)
  }

  async blockers(nodeId: string, options?: Omit<BlockerOptions, 'node_id'>): Promise<NodeSummary[]> {
    this.log('blockers', { nodeId, ...options })
    return this.client.blockers(nodeId, options)
  }

  async blocking(nodeId: string, options?: Omit<BlockerOptions, 'node_id'>): Promise<NodeSummary[]> {
    this.log('blocking', { nodeId, ...options })
    return this.client.blocking(nodeId, options)
  }

  async feedback(nodeId: string, options?: Omit<FeedbackOptions, 'node_id'>): Promise<FeedbackSummary[]> {
    this.log('feedback', { nodeId, ...options })
    return this.client.feedback(nodeId, options)
  }

  async blocks(fromId: string, toId: string): Promise<LinkResult> {
    this.log('blocks', { fromId, toId })
    return this.link({
      from_id: fromId,
      to_id: toId,
      type: 'blocks',
    })
  }

  async implements(issueId: string, specId: string): Promise<LinkResult> {
    this.log('implements', { issueId, specId })
    return this.link({
      from_id: issueId,
      to_id: specId,
      type: 'implements',
    })
  }

  async addFeedback(
    targetId: string,
    content: string,
    type: 'comment' | 'suggestion' | 'request' = 'comment'
  ): Promise<AnnotateResult> {
    this.log('addFeedback', { targetId, content, type })
    return this.annotate({
      target_id: targetId,
      create: { content, type },
    })
  }

  async resolveFeedback(targetId: string, feedbackId: string): Promise<AnnotateResult> {
    this.log('resolveFeedback', { targetId, feedbackId })
    return this.annotate({
      target_id: targetId,
      resolve: feedbackId,
    })
  }

  async dismissFeedback(targetId: string, feedbackId: string): Promise<AnnotateResult> {
    this.log('dismissFeedback', { targetId, feedbackId })
    return this.annotate({
      target_id: targetId,
      dismiss: feedbackId,
    })
  }

  async reopenFeedback(targetId: string, feedbackId: string): Promise<AnnotateResult> {
    this.log('reopenFeedback', { targetId, feedbackId })
    return this.annotate({
      target_id: targetId,
      reopen: feedbackId,
    })
  }

  disconnect(): void {
    this.log('disconnect')
    this.client.disconnect()
  }

  // ==========================================================================
  // Provider Operations
  // ==========================================================================

  async createSpec(title: string, options?: CreateSpecOptions): Promise<ProviderNode> {
    const provider = this.requireProvider()
    this.log('createSpec', { title, ...options })
    return provider.create({
      type: 'spec',
      title,
      content: options?.content,
      priority: options?.priority,
      metadata: options?.metadata,
    })
  }

  async createIssue(title: string, options?: CreateIssueOptions): Promise<ProviderNode> {
    const provider = this.requireProvider()
    this.log('createIssue', { title, ...options })
    return provider.create({
      type: 'issue',
      title,
      content: options?.description,
      status: options?.status ?? 'open',
      priority: options?.priority,
      metadata: options?.metadata,
    })
  }

  async updateNode(id: string, updates: ProviderUpdateInput): Promise<ProviderNode> {
    const provider = this.requireProvider()
    this.log('updateNode', { id, updates })
    return provider.update(id, updates)
  }

  async closeIssue(id: string): Promise<ProviderNode> {
    this.log('closeIssue', { id })
    return this.updateNode(id, { status: 'closed' })
  }

  async getNode(id: string): Promise<ProviderNode | null> {
    const provider = this.requireProvider()
    this.log('getNode', { id })
    return provider.get(id)
  }
}

/**
 * Create a test agent wrapping a client
 *
 * @param client - OpenTasksClient to wrap
 * @param options - Agent options
 * @returns TestAgent instance
 *
 * @example
 * ```typescript
 * const agent = createTestAgent(system.client, { name: 'agent1', verbose: true })
 *
 * // Use 3-tool interface
 * const result = await agent.link({
 *   from_id: 'i-abc1',
 *   to_id: 's-def2',
 *   type: 'implements'
 * })
 *
 * // Or use convenience methods
 * const ready = await agent.ready()
 * ```
 */
export function createTestAgent(client: OpenTasksClient, options?: TestAgentOptions): TestAgent {
  return new TestAgentImpl(client, options)
}

/**
 * Multi-agent context for coordinated testing
 */
export interface MultiAgentContext {
  /** Named agents */
  agents: Map<string, TestAgent>

  /** Get agent by name */
  get(name: string): TestAgent

  /** Disconnect all agents */
  disconnectAll(): void
}

/**
 * Create multiple test agents for the same system
 *
 * @param clientFactory - Function to create new clients
 * @param names - Names for each agent
 * @param options - Shared agent options (including provider for node operations)
 * @returns MultiAgentContext
 *
 * @example
 * ```typescript
 * const { agents, get, disconnectAll } = await createMultiAgents(
 *   () => system.createClient(),
 *   ['planner', 'implementer', 'reviewer'],
 *   { provider: system.nativeProvider }
 * )
 *
 * // Each agent operates independently
 * await get('planner').createSpec('Feature Spec')
 * await get('implementer').createIssue('Implement feature')
 *
 * // Clean up
 * disconnectAll()
 * ```
 */
export async function createMultiAgents(
  clientFactory: () => Promise<OpenTasksClient>,
  names: string[],
  options?: Omit<TestAgentOptions, 'name'>
): Promise<MultiAgentContext> {
  const agents = new Map<string, TestAgent>()

  for (const name of names) {
    const client = await clientFactory()
    const agent = createTestAgent(client, { ...options, name })
    agents.set(name, agent)
  }

  return {
    agents,
    get(name: string): TestAgent {
      const agent = agents.get(name)
      if (!agent) {
        throw new Error(`Agent '${name}' not found`)
      }
      return agent
    },
    disconnectAll(): void {
      for (const agent of agents.values()) {
        agent.disconnect()
      }
    },
  }
}
