/**
 * OpenTasks MCP Server
 *
 * Exposes the OpenTasks tool interface over Model Context Protocol (MCP).
 * Connects to the daemon via IPC client and routes all operations through
 * the existing provider system — any registered provider (native, beads,
 * sudocode, claude-tasks, etc.) is automatically available.
 *
 * Scopes:
 *   - tasks (default): Task CRUD + lifecycle — create, get, update, list
 *   - graph: Full graph operations — link, query (all node types, edges, blockers)
 *   - annotate: Feedback lifecycle — create, resolve, dismiss, reopen
 *   - context: Context/spec CRUD — create, get, update, list
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OpenTasksClient, type ClientOptions } from '../client/client.js';
import { VERSION } from '../version.js';
import { TASK_ACTIONS } from '../providers/traits/TaskManageable.js';

// ============================================================================
// Types
// ============================================================================

/** Available MCP scopes */
export type MCPScope = 'tasks' | 'graph' | 'annotate' | 'context';

export interface MCPServerOptions {
  /** Options for the OpenTasks client */
  clientOptions?: ClientOptions;

  /**
   * Which tool scopes to enable.
   * Default: ['tasks']
   */
  scopes?: MCPScope[];
}

// ============================================================================
// Server Factory
// ============================================================================

/**
 * Create an MCP server that exposes the OpenTasks tool interface.
 *
 * Default scope (tasks) provides 4 simple CRUD tools:
 *   create_task, get_task, update_task, list_tasks
 *
 * Additional scopes can be opted in:
 *   --scope tasks,graph,annotate,context
 */
export const ALL_SCOPES: MCPScope[] = ['tasks', 'graph', 'annotate', 'context'];

export function createMCPServer(options?: MCPServerOptions): McpServer {
  const client = new OpenTasksClient(options?.clientOptions);
  const scopes = new Set<MCPScope>(options?.scopes ?? ['tasks']);

  const server = new McpServer({
    name: 'opentasks',
    version: VERSION,
  });

  // Always register tasks scope
  if (scopes.has('tasks')) {
    registerTaskTools(server, client);
  }

  if (scopes.has('graph')) {
    registerGraphTools(server, client);
  }

  if (scopes.has('annotate')) {
    registerAnnotateTools(server, client);
  }

  if (scopes.has('context')) {
    registerContextTools(server, client);
  }

  return server;
}

// ============================================================================
// Scope: tasks (default)
// ============================================================================

function registerTaskTools(server: McpServer, client: OpenTasksClient): void {
  server.tool(
    'create_task',
    'Create a new task. Supports provider routing via scheme parameter (e.g. beads, sudocode).',
    {
      title: z.string().describe('Task title'),
      status: z.string().optional().describe('Initial status (default: open)'),
      content: z.string().optional().describe('Markdown description'),
      priority: z.number().optional().describe('Priority 0=highest, 4=lowest'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      assignee: z.string().optional().describe('Assigned user/agent'),
      parent_id: z.string().optional().describe('Parent node ID'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
      scheme: z.string().optional().describe('Provider scheme to route creation to (e.g. beads, sudocode)'),
      idempotency_key: z.string().optional().describe('Dedup key: retrying create with the same key returns the original task instead of a duplicate'),
    },
    async (args) => {
      try {
        const { scheme, idempotency_key, ...params } = args;
        const result = await client.createNode(
          { type: 'task', ...params },
          scheme || idempotency_key ? { scheme, idempotencyKey: idempotency_key } : undefined,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'get_task',
    'Get a task by ID or provider URI (e.g. t-abc1, beads://project/i-123).',
    {
      id: z.string().describe('Task ID or provider URI'),
    },
    async (args) => {
      try {
        const result = await client.getNode(args.id);
        if (!result) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Task not found', id: args.id }) }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'update_task',
    `Update a task's fields and/or transition its status. Supports adding/removing blockers.`,
    {
      id: z.string().describe('Task ID or provider URI'),
      // Field updates
      title: z.string().optional().describe('Update title'),
      content: z.string().optional().describe('Update description'),
      priority: z.number().optional().describe('Update priority'),
      status: z.string().optional().describe('Update status directly'),
      assignee: z.string().optional().describe('Update assignee'),
      tags: z.array(z.string()).optional().describe('Update tags'),
      archived: z.boolean().optional().describe('Archive/unarchive'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Update metadata (merged)'),
      // Semantic transitions
      transition: z.enum(TASK_ACTIONS).optional()
        .describe('Semantic status transition (alternative to setting status directly). fail/abandon are terminal outcomes distinct from complete/close.'),
      // Blocker management
      addBlockedBy: z.array(z.string()).optional().describe('Add blocker task IDs (these block this task)'),
      removeBlockedBy: z.array(z.string()).optional().describe('Remove blocker task IDs'),
      addBlocks: z.array(z.string()).optional().describe('Add task IDs that this task blocks'),
      removeBlocks: z.array(z.string()).optional().describe('Remove task IDs that this task blocks'),
    },
    async (args) => {
      const results: Array<{ op: string; success: boolean; result?: unknown; error?: string }> = [];

      const { id, transition, addBlockedBy, removeBlockedBy, addBlocks, removeBlocks, tags, ...fieldUpdates } = args;
      const hasFieldUpdates = Object.values(fieldUpdates).some((v) => v !== undefined);

      // 1. Apply field updates if any
      if (hasFieldUpdates) {
        try {
          const updateResult = await client.updateNode(id, fieldUpdates);
          results.push({ op: 'update', success: true, result: updateResult });
        } catch (error) {
          results.push({ op: 'update', success: false, error: errorMessage(error) });
        }
      }

      // 2. Apply semantic transition if requested
      if (transition) {
        try {
          const transitionResult = await client.task({ transition: { id, action: transition } });
          if (transitionResult.success) {
            results.push({ op: 'transition', success: true, result: transitionResult });
          } else {
            results.push({ op: 'transition', success: false, error: transitionResult.error || 'Transition failed' });
          }
        } catch (error) {
          results.push({ op: 'transition', success: false, error: errorMessage(error) });
        }
      }

      // 3. Apply blocker changes
      if (addBlockedBy?.length) {
        for (const blockerId of addBlockedBy) {
          try {
            const r = await client.link({ fromId: blockerId, toId: id, type: 'blocks' });
            results.push({ op: 'addBlockedBy', success: r.success, result: r });
          } catch (error) {
            results.push({ op: 'addBlockedBy', success: false, error: errorMessage(error) });
          }
        }
      }
      if (removeBlockedBy?.length) {
        for (const blockerId of removeBlockedBy) {
          try {
            const r = await client.link({ fromId: blockerId, toId: id, type: 'blocks', remove: true });
            results.push({ op: 'removeBlockedBy', success: r.success, result: r });
          } catch (error) {
            results.push({ op: 'removeBlockedBy', success: false, error: errorMessage(error) });
          }
        }
      }
      if (addBlocks?.length) {
        for (const blockedId of addBlocks) {
          try {
            const r = await client.link({ fromId: id, toId: blockedId, type: 'blocks' });
            results.push({ op: 'addBlocks', success: r.success, result: r });
          } catch (error) {
            results.push({ op: 'addBlocks', success: false, error: errorMessage(error) });
          }
        }
      }
      if (removeBlocks?.length) {
        for (const blockedId of removeBlocks) {
          try {
            const r = await client.link({ fromId: id, toId: blockedId, type: 'blocks', remove: true });
            results.push({ op: 'removeBlocks', success: r.success, result: r });
          } catch (error) {
            results.push({ op: 'removeBlocks', success: false, error: errorMessage(error) });
          }
        }
      }

      // Build response
      const anyFailed = results.some((r) => !r.success);
      const output = results.length === 1 ? results[0] : { operations: results };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        isError: anyFailed,
      };
    },
  );

  server.tool(
    'delete_task',
    'Delete a task by ID or provider URI. For provider-backed tasks, deletes from both the provider and the local graph.',
    {
      id: z.string().describe('Task ID or provider URI'),
    },
    async (args) => {
      try {
        await client.deleteNode(args.id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id: args.id }) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'list_providers',
    'List all registered providers and their capabilities (schemes, status models, supported actions).',
    {},
    async () => {
      try {
        const result = await client.listProviders();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'reconcile',
    'Trigger provider reconciliation. Syncs cached provider-backed nodes with their source providers. Returns a diff summary showing which nodes were updated, unchanged, or unavailable.',
    {
      providers: z.array(z.string()).optional().describe('Only reconcile these provider names'),
      node_ids: z.array(z.string()).optional().describe('Only reconcile these node IDs'),
    },
    async (args) => {
      try {
        const result = await client.reconcileProviders({
          providers: args.providers,
          nodeIds: args.node_ids,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'list_tasks',
    'List and filter tasks. Get ready tasks, find blockers, or query by status/tags/assignee.',
    {
      // Filter options
      status: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by status(es)'),
      tags: z.array(z.string()).optional().describe('Filter by tags (AND semantics)'),
      assignee: z.string().optional().describe('Filter by assignee'),
      priority: z.union([z.number(), z.object({ min: z.number().optional(), max: z.number().optional() })]).optional()
        .describe('Filter by priority (single value or range)'),
      search: z.string().optional().describe('Text search in title and content'),
      archived: z.boolean().optional().describe('Include archived tasks (default: false)'),
      // Ready query
      ready: z.boolean().optional().describe('Only show tasks ready to work on (no active blockers)'),
      // Blocker queries
      blockersOf: z.string().optional().describe('Get tasks blocking this task ID'),
      blockedBy: z.string().optional().describe('Get tasks blocked by this task ID'),
      // Pagination
      limit: z.number().optional().describe('Maximum results (default: 50)'),
      offset: z.number().optional().describe('Pagination offset'),
      orderBy: z.enum(['created_at', 'updated_at', 'priority', 'title']).optional(),
      orderDirection: z.enum(['asc', 'desc']).optional(),
      // Provider filtering
      providers: z.array(z.string()).optional().describe('Only query these providers (for ready queries)'),
    },
    async (args) => {
      try {
        const { ready, blockersOf, blockedBy, providers, ...filters } = args;

        // Ready query — federated across providers
        if (ready) {
          const result = await client.task({
            ready: {
              providers,
              limit: filters.limit,
              tags: filters.tags,
              assignee: filters.assignee,
              priority: typeof filters.priority === 'number' ? filters.priority : undefined,
            },
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        // Blocker queries
        if (blockersOf) {
          const result = await client.query({ blockers: { nodeId: blockersOf } });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        if (blockedBy) {
          const result = await client.query({ blocking: { nodeId: blockedBy } });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        // General task list
        const result = await client.query({
          nodes: { type: 'task', ...filters },
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'claim_task',
    'Atomically claim a task for an agent (lease-based, race-free). Returns claimed:false (not an error) when another agent already holds it. Use the returned fence with release_task/renew_claim.',
    {
      id: z.string().describe('Task ID (native tasks only)'),
      agentId: z.string().describe('Agent acquiring the claim'),
      durationMs: z.number().optional().describe('Lease duration in ms (default: 30 min)'),
      force: z.boolean().optional().describe('Claim even if held by another, unexpired agent'),
    },
    async (args) => {
      try {
        const result = await client.task({ claim: args });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'claim_next',
    'Atomically claim the next ready, unclaimed task for an agent (fused ready-query + claim). Returns claimed:false when nothing is available.',
    {
      agentId: z.string().describe('Agent acquiring the claim'),
      durationMs: z.number().optional().describe('Lease duration in ms (default: 30 min)'),
    },
    async (args) => {
      try {
        const result = await client.task({ claimNext: args });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'release_task',
    'Release a claim on a task. Pass the fence from claim_task to reject a stale/superseded release.',
    {
      id: z.string().describe('Task ID (native tasks only)'),
      agentId: z.string().describe('Agent that holds the claim'),
      fence: z.number().optional().describe('Fence token from the claim'),
    },
    async (args) => {
      try {
        const result = await client.task({ release: args });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'renew_claim',
    "Renew/extend a claim's lease (heartbeat). Pass the fence from claim_task to reject a stale/superseded renew.",
    {
      id: z.string().describe('Task ID (native tasks only)'),
      agentId: z.string().describe('Agent that holds the claim'),
      durationMs: z.number().optional().describe('New lease duration in ms (default: 30 min)'),
      fence: z.number().optional().describe('Fence token from the claim'),
    },
    async (args) => {
      try {
        const result = await client.task({ renew: args });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

// ============================================================================
// Scope: graph (opt-in)
// ============================================================================

function registerGraphTools(server: McpServer, client: OpenTasksClient): void {
  server.tool(
    'link',
    'Create or remove an edge between two nodes. Supports local IDs (e.g. t-abc1) and provider URIs (e.g. beads://project/i-123).',
    {
      fromId: z.string().describe('Source node ID or provider URI'),
      toId: z.string().describe('Target node ID or provider URI'),
      type: z.string().describe('Relationship type: blocks, implements, references, depends-on, related, parent-of, child-of, duplicates, supersedes, discovered-from'),
      remove: z.boolean().optional().describe('Remove the edge instead of creating (default: false)'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
    },
    async (args) => {
      try {
        const result = await client.link(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'query',
    `Query the full task graph. Specify exactly ONE query type:
- nodes: Filter any node type by status, tags, priority, assignee, search
- edges: Filter edges by type, from_id, to_id
- ready: Get unblocked tasks ready to work on
- blockers/blocking: Dependency traversal
- feedback/unresolvedFeedback: Feedback queries
- tasks: Get tasks implementing a context
- context: Get context nodes a task implements
- contextSummary: Get breadcrumbs for session continuity (active, blocked, completed tasks, etc.)`,
    {
      nodes: z.object({
        type: z.union([z.string(), z.array(z.string())]).optional().describe('Node type(s): context, task, feedback, external'),
        status: z.union([z.string(), z.array(z.string())]).optional(),
        tags: z.array(z.string()).optional(),
        parent_id: z.string().optional(),
        archived: z.boolean().nullable().optional(),
        search: z.string().optional(),
        priority: z.union([z.number(), z.object({ min: z.number().optional(), max: z.number().optional() })]).optional(),
        assignee: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
        orderBy: z.enum(['created_at', 'updated_at', 'priority', 'title']).optional(),
        orderDirection: z.enum(['asc', 'desc']).optional(),
      }).optional(),

      edges: z.object({
        type: z.union([z.string(), z.array(z.string())]).optional(),
        from_id: z.string().optional(),
        to_id: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }).optional(),

      ready: z.object({
        tags: z.array(z.string()).optional(),
        priority: z.union([z.number(), z.object({ min: z.number().optional(), max: z.number().optional() })]).optional(),
        assignee: z.string().optional(),
        limit: z.number().optional(),
      }).optional(),

      blockers: z.object({
        nodeId: z.string(),
        transitive: z.boolean().optional(),
        activeOnly: z.boolean().optional(),
      }).optional(),

      blocking: z.object({
        nodeId: z.string(),
        transitive: z.boolean().optional(),
        activeOnly: z.boolean().optional(),
      }).optional(),

      feedback: z.object({
        nodeId: z.string(),
        type: z.enum(['comment', 'suggestion', 'request']).optional(),
        resolved: z.boolean().optional(),
        includeDismissed: z.boolean().optional(),
      }).optional(),

      unresolvedFeedback: z.object({
        targetId: z.string().optional(),
      }).optional(),

      tasks: z.object({
        contextId: z.string(),
      }).optional(),

      context: z.object({
        taskId: z.string(),
      }).optional(),

      contextSummary: z.object({
        taskId: z.string().optional().describe('Find context related to a specific task'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        branch: z.string().optional().describe('Filter by branch'),
        limit: z.number().optional().describe('Max breadcrumbs per section (default: 10)'),
      }).optional(),

      verbose: z.boolean().optional().describe('Return full objects instead of summaries (default: false)'),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (args) => {
      try {
        const result = await client.query(args as any);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'context_summary',
    'Get context summary breadcrumbs for session continuity. Returns recently completed tasks, active tasks, blocked tasks, related contexts, and unresolved feedback.',
    {
      taskId: z.string().optional().describe('Find context related to a specific task'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      branch: z.string().optional().describe('Filter by branch'),
      limit: z.number().optional().describe('Max breadcrumbs per section (default: 10)'),
    },
    async (args) => {
      try {
        const result = await client.contextSummary(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'events_since',
    `Pull graph change events since a cursor (token-cheap polling — get just what changed instead of re-querying the world).
Pass back the { epoch, seq } cursor from a previous call; omit both to get a baseline cursor from the current head (no events).
Returns { events, nextCursor }. If the cursor is too old or the daemon restarted, returns { resync: true, nextCursor } — re-query state and adopt nextCursor.`,
    {
      epoch: z.string().optional().describe('Cursor epoch from a prior call (omit for a baseline)'),
      seq: z.number().optional().describe('Cursor seq from a prior call (omit for a baseline)'),
    },
    async (args) => {
      try {
        // No cursor → hand back the current head as a baseline to poll from.
        if (args.epoch === undefined || args.seq === undefined) {
          const cursor = await client.eventsCurrent();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ events: [], nextCursor: cursor }, null, 2),
              },
            ],
          };
        }

        const result = await client.eventsSince({ epoch: args.epoch, seq: args.seq });
        if ('resync' in result && result.resync) {
          const cursor = await client.eventsCurrent();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ resync: true, nextCursor: cursor }, null, 2),
              },
            ],
          };
        }

        const events = result.events;
        const last = events.length > 0 ? events[events.length - 1] : null;
        const nextCursor = last
          ? { epoch: last.epoch, seq: last.seq }
          : { epoch: args.epoch, seq: args.seq };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ events, nextCursor }, null, 2),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

// ============================================================================
// Scope: annotate (opt-in)
// ============================================================================

function registerAnnotateTools(server: McpServer, client: OpenTasksClient): void {
  server.tool(
    'annotate',
    `Manage feedback on any node. Specify targetId and exactly ONE operation:
- create: Add new feedback (comment, suggestion, or request)
- resolve: Mark feedback as resolved
- dismiss: Dismiss feedback
- reopen: Reopen resolved/dismissed feedback`,
    {
      targetId: z.string().describe('Target node ID receiving annotation'),
      create: z.object({
        content: z.string().describe('Feedback content (markdown)'),
        type: z.enum(['comment', 'suggestion', 'request']).optional().describe('Feedback type (default: comment)'),
        anchor: z.object({
          line: z.number().optional().describe('Line number in target content'),
          text: z.string().optional().describe('Text snippet to anchor to'),
        }).optional(),
      }).optional().describe('Create new feedback'),
      resolve: z.string().optional().describe('Feedback ID to resolve'),
      dismiss: z.string().optional().describe('Feedback ID to dismiss'),
      reopen: z.string().optional().describe('Feedback ID to reopen'),
      fromId: z.string().optional().describe('Source node ID (creates discovered-from link)'),
    },
    async (args) => {
      try {
        const result = await client.annotate(args as any);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

// ============================================================================
// Scope: context (opt-in)
// ============================================================================

function registerContextTools(server: McpServer, client: OpenTasksClient): void {
  server.tool(
    'create_context',
    `Create a context node. Contexts capture requirements, specs, design decisions, or references to codebase files.

Source types:
- file: Reference a codebase file (content resolved on access, not stored)
- inline (default): Content stored directly in the node
- snippet: Reference specific lines in a file

Kinds:
Pass \`kind: "spec"\` when authoring a specification — a briefing that agents or swarms will implement against. Spec-kind contexts are first-class in downstream consumers (e.g. OpenHive's Specs UI) and surface as dispatchable work; plain contexts are background reference material. The marker is stored as \`metadata.kind\` and travels with the node.`,
    {
      title: z.string().optional().describe('Context title (auto-derived from file path if source is file/snippet)'),
      content: z.string().optional().describe('Markdown content (for inline contexts)'),
      priority: z.number().optional().describe('Priority 0=highest, 4=lowest'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      parent_id: z.string().optional().describe('Parent node ID'),
      kind: z.string().optional().describe('Context kind marker (e.g. "spec" for dispatchable specifications). Written to metadata.kind; merges with any explicit metadata param, with metadata.kind winning if both are set.'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
      scheme: z.string().optional().describe('Provider scheme to route creation to'),
      source: z.discriminatedUnion('type', [
        z.object({
          type: z.literal('file'),
          path: z.string().describe('Repo-relative file path'),
          commit: z.string().optional().describe('Pin to specific commit (default: HEAD)'),
        }),
        z.object({
          type: z.literal('snippet'),
          path: z.string().describe('Repo-relative file path'),
          startLine: z.number().describe('Start line number'),
          endLine: z.number().describe('End line number'),
        }),
      ]).optional().describe('Content source. Omit for inline content stored in the node.'),
    },
    async (args) => {
      try {
        const { scheme, source, kind, ...rest } = args;
        // Merge the top-level `kind` into metadata so the wire shape
        // still carries a single `metadata.kind` marker. An explicit
        // `metadata.kind` overrides the top-level sugar.
        const params = {
          ...rest,
          metadata:
            kind !== undefined
              ? { kind, ...(rest.metadata ?? {}) }
              : rest.metadata,
        };

        // File-backed context — delegate to contextFiles.create
        if (source?.type === 'file') {
          const result = await client.createContextFile({
            filePath: source.path,
            title: params.title,
            tags: params.tags,
            priority: params.priority,
            commit: source.commit,
          });
          // If a kind marker was requested, patch it onto the file-backed
          // node — `createContextFile` doesn't accept a metadata bag.
          if (kind !== undefined) {
            const updated = await client.updateNode(result.id, {
              metadata: {
                ...((result.metadata as Record<string, unknown>) ?? {}),
                kind,
              },
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(updated, null, 2) }] };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        // Snippet context — create as file-backed with line range in metadata
        if (source?.type === 'snippet') {
          const result = await client.createContextFile({
            filePath: source.path,
            title: params.title,
            tags: params.tags,
            priority: params.priority,
          });
          const updated = await client.updateNode(result.id, {
            metadata: {
              ...((result.metadata as Record<string, unknown>) ?? {}),
              context_source: 'snippet',
              context_line_start: source.startLine,
              context_line_end: source.endLine,
              ...(kind !== undefined ? { kind } : {}),
            },
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(updated, null, 2) }] };
        }

        // Inline context — existing behavior
        if (!params.title) {
          return errorResult(new Error('title is required for inline contexts'));
        }
        const result = await client.createNode(
          { type: 'context', ...params, title: params.title },
          scheme ? { scheme } : undefined,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'get_context',
    `Get a context node by ID. For file-backed contexts, optionally resolve the file content.

By default returns the node metadata (lightweight). Use resolve: true to include file content.`,
    {
      id: z.string().describe('Context ID or provider URI'),
      resolve: z.boolean().optional().describe('Resolve file content for file-backed contexts (default: false)'),
      atCapturedCommit: z.boolean().optional()
        .describe('Resolve at the originally captured commit instead of current worktree (only with resolve: true)'),
    },
    async (args) => {
      try {
        const node = await client.getNode(args.id) as Record<string, unknown> | null;
        if (!node) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Context not found', id: args.id }) }],
            isError: true,
          };
        }

        // If resolve requested and this is a file-backed context, include content
        if (args.resolve) {
          const metadata = node.metadata as Record<string, unknown> | undefined;
          if (metadata?.context_file === true) {
            try {
              const resolution = await client.resolveContextFile(args.id, args.atCapturedCommit);
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({ ...node, _resolved: resolution }, null, 2),
                }],
              };
            } catch (resolveError) {
              // Return node + resolution error (file may have been deleted)
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    ...node,
                    _resolved: { error: errorMessage(resolveError) },
                  }, null, 2),
                }],
              };
            }
          }
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(node, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'update_context',
    `Update a context node. For file-backed contexts, use sync: true to re-pin to current HEAD.`,
    {
      id: z.string().describe('Context ID or provider URI'),
      title: z.string().optional(),
      content: z.string().optional(),
      priority: z.number().optional(),
      archived: z.boolean().optional(),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata (merged with existing)'),
      // Context-file specific
      sync: z.boolean().optional().describe('Re-pin file-backed context to current HEAD'),
      force: z.boolean().optional().describe('Force sync even if content hash unchanged (with sync: true)'),
    },
    async (args) => {
      try {
        const { id, sync, force, ...updates } = args;
        const results: Array<{ op: string; success: boolean; result?: unknown; error?: string }> = [];

        // Apply field updates if any
        const hasFieldUpdates = Object.values(updates).some((v) => v !== undefined);
        if (hasFieldUpdates) {
          try {
            const updateResult = await client.updateNode(id, updates);
            results.push({ op: 'update', success: true, result: updateResult });
          } catch (error) {
            results.push({ op: 'update', success: false, error: errorMessage(error) });
          }
        }

        // Sync file-backed context if requested
        if (sync) {
          try {
            const syncResult = await client.syncContextFile(id, { force });
            results.push({ op: 'sync', success: true, result: syncResult });
          } catch (error) {
            results.push({ op: 'sync', success: false, error: errorMessage(error) });
          }
        }

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No operations specified' }) }], isError: true };
        }

        const anyFailed = results.some((r) => !r.success);
        const output = results.length === 1 ? results[0].result : { operations: results };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
          isError: anyFailed,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'list_contexts',
    `List and filter context nodes. Optionally check drift status for file-backed contexts.`,
    {
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      search: z.string().optional().describe('Text search in title and content'),
      archived: z.boolean().optional().describe('Include archived (default: false)'),
      limit: z.number().optional().describe('Maximum results (default: 50)'),
      offset: z.number().optional().describe('Pagination offset'),
      // Context-file specific
      filesOnly: z.boolean().optional().describe('Only return file-backed contexts'),
      checkDrift: z.boolean().optional().describe('Include drift status for file-backed contexts'),
    },
    async (args) => {
      try {
        const { filesOnly, checkDrift, ...queryArgs } = args;
        const result = await client.query({
          nodes: { type: 'context', ...queryArgs },
        });

        let items = result.items as unknown as Array<Record<string, unknown>>;

        // Filter to file-backed only if requested
        if (filesOnly) {
          items = items.filter((item) => {
            const meta = item.metadata as Record<string, unknown> | undefined;
            return meta?.context_file === true;
          });
        }

        // Check drift for file-backed contexts if requested
        if (checkDrift) {
          const fileItems = items.filter((item) => {
            const meta = item.metadata as Record<string, unknown> | undefined;
            return meta?.context_file === true;
          });

          if (fileItems.length > 0) {
            const ids = fileItems.map((item) => item.id as string);
            try {
              const driftResults = await client.checkContextFileDriftBatch(ids);
              // Attach drift info to each file-backed item
              for (let i = 0; i < fileItems.length; i++) {
                (fileItems[i] as Record<string, unknown>)._drift = driftResults[i];
              }
            } catch {
              // Best-effort: drift check may fail if files are deleted
            }
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ...result, items }, null, 2),
          }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

// ============================================================================
// Helpers
// ============================================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: errorMessage(error) }) }],
    isError: true as const,
  };
}
