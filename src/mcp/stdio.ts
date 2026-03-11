/**
 * OpenTasks MCP Server - Stdio Transport
 *
 * Entry point for running the MCP server over stdio.
 * Used by: `opentasks mcp` CLI command.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMCPServer, type MCPServerOptions } from './server.js';

/**
 * Start the MCP server with stdio transport.
 *
 * @param options - Server options
 */
export async function startMCPServer(options?: MCPServerOptions): Promise<void> {
  const server = createMCPServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
