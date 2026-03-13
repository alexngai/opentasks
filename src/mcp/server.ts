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
    version: '0.0.5',
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
    },
    async (args) => {
      try {
        const { scheme, ...params } = args;
        const result = await client.createNode(
          { type: 'task', ...params },
          scheme ? { scheme } : undefined,
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
      transition: z.enum(['start', 'complete', 'block', 'reopen', 'close']).optional()
        .describe('Semantic status transition (alternative to setting status directly)'),
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
    'list_providers',
    'List all registered providers and their capabilities.',
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
    'Create a new context/spec node. Contexts define requirements, goals, or specifications that tasks implement.',
    {
      title: z.string().describe('Context title'),
      content: z.string().optional().describe('Markdown content (requirements, specs, etc.)'),
      priority: z.number().optional().describe('Priority 0=highest, 4=lowest'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      parent_id: z.string().optional().describe('Parent node ID'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
      scheme: z.string().optional().describe('Provider scheme to route creation to'),
    },
    async (args) => {
      try {
        const { scheme, ...params } = args;
        const result = await client.createNode(
          { type: 'context', ...params },
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
    'Get a context/spec node by ID or provider URI.',
    {
      id: z.string().describe('Context ID or provider URI'),
    },
    async (args) => {
      try {
        const result = await client.getNode(args.id);
        if (!result) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Context not found', id: args.id }) }],
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
    'update_context',
    'Update a context/spec node.',
    {
      id: z.string().describe('Context ID or provider URI'),
      title: z.string().optional(),
      content: z.string().optional(),
      priority: z.number().optional(),
      archived: z.boolean().optional(),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata (merged with existing)'),
    },
    async (args) => {
      try {
        const { id, ...updates } = args;
        const result = await client.updateNode(id, updates);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'list_contexts',
    'List and filter context/spec nodes.',
    {
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      search: z.string().optional().describe('Text search in title and content'),
      archived: z.boolean().optional().describe('Include archived (default: false)'),
      limit: z.number().optional().describe('Maximum results (default: 50)'),
      offset: z.number().optional().describe('Pagination offset'),
    },
    async (args) => {
      try {
        const result = await client.query({
          nodes: { type: 'context', ...args },
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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
