/**
 * IPC Server
 *
 * Unix domain socket server with JSON-RPC 2.0 protocol.
 * Handles line-delimited JSON requests and routes to method handlers.
 */

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import { DaemonError } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * JSON-RPC 2.0 request
 */
export interface IPCRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 response
 */
export interface IPCResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: IPCError;
}

/**
 * JSON-RPC 2.0 error
 */
export interface IPCError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Method handler function
 */
export type MethodHandler<P = unknown, R = unknown> = (params: P) => Promise<R>;

/**
 * IPC server interface
 */
export interface IPCServer {
  /** Start listening on socket */
  start(): Promise<void>;

  /** Stop accepting connections and close existing ones */
  stop(): Promise<void>;

  /** Register a method handler */
  handle<P = unknown, R = unknown>(method: string, handler: MethodHandler<P, R>): void;

  /** Get current connection count */
  getConnectionCount(): number;

  /** Socket path */
  readonly socketPath: string;
}

// ============================================================================
// JSON-RPC Error Codes
// ============================================================================

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
} as const;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an IPC server
 *
 * @param socketPath - Path to Unix socket file
 */
export function createIPCServer(socketPath: string): IPCServer {
  const handlers = new Map<string, MethodHandler>();
  const connections = new Set<net.Socket>();
  let server: net.Server | null = null;

  /**
   * Create error response
   */
  function errorResponse(
    id: string | number | null,
    error: { code: number; message: string },
    data?: unknown,
  ): IPCResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { ...error, data },
    };
  }

  /**
   * Create success response
   */
  function successResponse(id: string | number | null, result: unknown): IPCResponse {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  /**
   * Validate JSON-RPC request
   */
  function validateRequest(data: unknown): IPCRequest | IPCError {
    if (typeof data !== 'object' || data === null) {
      return JSON_RPC_ERRORS.INVALID_REQUEST;
    }

    const req = data as Record<string, unknown>;

    if (req.jsonrpc !== '2.0') {
      return JSON_RPC_ERRORS.INVALID_REQUEST;
    }

    if (typeof req.method !== 'string') {
      return JSON_RPC_ERRORS.INVALID_REQUEST;
    }

    // id can be string, number, or null (for notifications)
    if (
      req.id !== undefined &&
      req.id !== null &&
      typeof req.id !== 'string' &&
      typeof req.id !== 'number'
    ) {
      return JSON_RPC_ERRORS.INVALID_REQUEST;
    }

    return {
      jsonrpc: '2.0',
      id: (req.id as string | number | null) ?? null,
      method: req.method,
      params: req.params,
    };
  }

  /**
   * Handle a single request
   */
  async function handleRequest(request: IPCRequest): Promise<IPCResponse | null> {
    // Notifications (id is null) don't get responses
    const isNotification = request.id === null;

    const handler = handlers.get(request.method);
    if (!handler) {
      if (isNotification) return null;
      return errorResponse(request.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND);
    }

    try {
      const result = await handler(request.params);
      if (isNotification) return null;
      return successResponse(request.id, result);
    } catch (error) {
      if (isNotification) return null;

      // Handle typed errors
      if (error instanceof DaemonError) {
        return errorResponse(request.id, JSON_RPC_ERRORS.INTERNAL_ERROR, {
          code: error.code,
          message: error.message,
        });
      }

      return errorResponse(request.id, JSON_RPC_ERRORS.INTERNAL_ERROR, (error as Error).message);
    }
  }

  /**
   * Process incoming data from a connection
   */
  function handleConnection(socket: net.Socket): void {
    connections.add(socket);

    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      // Process complete lines
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim() === '') continue;

        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          const response = errorResponse(null, JSON_RPC_ERRORS.PARSE_ERROR);
          socket.write(JSON.stringify(response) + '\n');
          continue;
        }

        // Validate request
        const requestOrError = validateRequest(parsed);
        if ('code' in requestOrError) {
          const response = errorResponse(null, requestOrError);
          socket.write(JSON.stringify(response) + '\n');
          continue;
        }

        // Handle request
        const response = await handleRequest(requestOrError);
        if (response) {
          socket.write(JSON.stringify(response) + '\n');
        }
      }
    });

    socket.on('close', () => {
      connections.delete(socket);
    });

    socket.on('error', () => {
      connections.delete(socket);
    });
  }

  return {
    socketPath,

    async start(): Promise<void> {
      if (server) {
        throw new DaemonError('IPC_ERROR', 'Server already started');
      }

      // Remove existing socket file
      try {
        await fs.unlink(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      return new Promise((resolve, reject) => {
        server = net.createServer(handleConnection);

        server.on('error', (error) => {
          reject(new DaemonError('IPC_ERROR', `Server error: ${error.message}`, error));
        });

        server.listen(socketPath, () => {
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (!server) {
        return;
      }

      // Close all connections
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();

      // Close server
      return new Promise((resolve) => {
        server!.close(() => {
          server = null;
          resolve();
        });
      });
    },

    handle<P = unknown, R = unknown>(method: string, handler: MethodHandler<P, R>): void {
      handlers.set(method, handler as MethodHandler);
    },

    getConnectionCount(): number {
      return connections.size;
    },
  };
}

// ============================================================================
// Client (for testing and internal use)
// ============================================================================

/**
 * Simple IPC client for testing
 */
export interface IPCClient {
  /** Connect to server */
  connect(): Promise<void>;

  /** Disconnect from server */
  disconnect(): void;

  /** Send request and wait for response */
  request<R = unknown>(method: string, params?: unknown): Promise<R>;

  /** Check if connected */
  readonly connected: boolean;
}

/**
 * Create an IPC client
 */
export function createIPCClient(socketPath: string): IPCClient {
  let socket: net.Socket | null = null;
  let requestId = 0;
  const pendingRequests = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let buffer = '';

  function processBuffer(): void {
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (line.trim() === '') continue;

      try {
        const response = JSON.parse(line) as IPCResponse;
        const pending = pendingRequests.get(response.id!);
        if (pending) {
          pendingRequests.delete(response.id!);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        // Ignore parse errors in response
      }
    }
  }

  return {
    get connected(): boolean {
      return socket !== null && !socket.destroyed;
    },

    async connect(): Promise<void> {
      if (socket) {
        throw new Error('Already connected');
      }

      return new Promise((resolve, reject) => {
        socket = net.createConnection(socketPath);

        socket.on('connect', () => {
          resolve();
        });

        socket.on('error', (error) => {
          reject(error);
        });

        socket.on('data', (data) => {
          buffer += data.toString();
          processBuffer();
        });

        socket.on('close', () => {
          // Reject all pending requests
          for (const [, pending] of pendingRequests) {
            pending.reject(new Error('Connection closed'));
          }
          pendingRequests.clear();
          socket = null;
        });
      });
    },

    disconnect(): void {
      if (socket) {
        socket.destroy();
        socket = null;
      }
    },

    async request<R = unknown>(method: string, params?: unknown): Promise<R> {
      if (!socket || socket.destroyed) {
        throw new Error('Not connected');
      }

      const id = ++requestId;
      const request: IPCRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      return new Promise((resolve, reject) => {
        pendingRequests.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });

        socket!.write(JSON.stringify(request) + '\n');

        // Timeout after 30 seconds
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error('Request timeout'));
          }
        }, 30000);
      });
    },
  };
}
