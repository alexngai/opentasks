/**
 * Redirect Rules System for OpenTasks (Phase 2)
 *
 * Routes operations to configured target locations based on
 * pattern matching and priority.
 */

import type { Connection } from './connections.js'
import type { LocationIdentity } from './location.js'
import { resolveOpentasksUri, type ResolvedLocation } from './uri.js'

/**
 * Operations that can be redirected
 */
export type RedirectOperation = 'read' | 'write'

/**
 * Redirect rule configuration
 */
export interface RedirectRule {
  /** Operations this rule applies to */
  operations: RedirectOperation[]
  /** Glob pattern for node IDs (e.g., "*", "i-*", "s-*") */
  pattern: string
  /** Target location (opentasks:// URI or location hash) */
  target: string
  /** Priority: lower = higher priority (default: 100) */
  priority: number
  /** Fallback behavior when target is unreachable */
  fallback: 'local' | 'error'
}

/**
 * Result of redirect resolution
 */
export interface RedirectResult {
  /** Whether a redirect was found */
  redirected: boolean
  /** The matching rule (if redirected) */
  rule?: RedirectRule
  /** Resolved target location (if redirected) */
  resolved?: ResolvedLocation
}

/**
 * Maximum redirect depth to prevent infinite loops
 */
const MAX_REDIRECT_DEPTH = 3

/**
 * Simple glob matcher for node ID patterns
 *
 * Supports:
 *   "*"    - matches anything
 *   "i-*"  - matches IDs starting with "i-"
 *   "s-*"  - matches IDs starting with "s-"
 *   exact  - exact match
 */
export function matchPattern(pattern: string, nodeId: string): boolean {
  if (pattern === '*') return true

  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1)
    return nodeId.startsWith(prefix)
  }

  return pattern === nodeId
}

/**
 * Find the first matching redirect rule for an operation
 *
 * Rules are sorted by priority (ascending, lower = higher priority).
 * First match wins.
 *
 * @param operation - The operation type ('read' or 'write')
 * @param nodeId - The node ID being operated on
 * @param rules - Available redirect rules
 * @returns The matching rule or null
 */
export function findRedirectRule(
  operation: RedirectOperation,
  nodeId: string,
  rules: RedirectRule[]
): RedirectRule | null {
  // Sort by priority (ascending)
  const sorted = [...rules].sort((a, b) => a.priority - b.priority)

  for (const rule of sorted) {
    if (!rule.operations.includes(operation)) continue
    if (!matchPattern(rule.pattern, nodeId)) continue
    return rule
  }

  return null
}

/**
 * Resolve a redirect rule to a target location
 *
 * @param rule - The redirect rule to resolve
 * @param connections - Available connections
 * @param currentLocation - Current location identity
 * @param currentOpentasksPath - Path to current .opentasks directory
 * @param depth - Current redirect depth (for loop prevention)
 * @returns Resolved location or null on failure
 */
export function resolveRedirect(
  rule: RedirectRule,
  connections: Connection[],
  currentLocation: LocationIdentity,
  currentOpentasksPath: string,
  depth: number = 0
): ResolvedLocation | null {
  if (depth >= MAX_REDIRECT_DEPTH) {
    throw new Error(
      `Redirect depth exceeded maximum of ${MAX_REDIRECT_DEPTH} hops`
    )
  }

  const target = rule.target

  // If target is just a hash, build a URI
  const uri = target.startsWith('opentasks://')
    ? target
    : `opentasks://${target}/`

  try {
    // For hash-only targets (e.g., "opentasks://k7m2x9p4/"), extract just the location
    const resolved = resolveOpentasksUri(
      uri.endsWith('/') ? uri + '__placeholder__' : uri,
      connections,
      currentLocation,
      currentOpentasksPath
    )

    return resolved
  } catch {
    return null
  }
}

/**
 * Resolve a complete redirect for an operation
 *
 * @param operation - The operation type
 * @param nodeId - The node ID
 * @param rules - Redirect rules
 * @param connections - Available connections
 * @param currentLocation - Current location identity
 * @param currentOpentasksPath - Path to current .opentasks directory
 * @returns Redirect result
 */
export function resolveOperationRedirect(
  operation: RedirectOperation,
  nodeId: string,
  rules: RedirectRule[],
  connections: Connection[],
  currentLocation: LocationIdentity,
  currentOpentasksPath: string
): RedirectResult {
  const rule = findRedirectRule(operation, nodeId, rules)

  if (!rule) {
    return { redirected: false }
  }

  const resolved = resolveRedirect(
    rule,
    connections,
    currentLocation,
    currentOpentasksPath
  )

  if (!resolved) {
    // Target unreachable — apply fallback
    if (rule.fallback === 'error') {
      throw new Error(
        `Redirect target unreachable for rule (pattern: ${rule.pattern}, target: ${rule.target})`
      )
    }
    // fallback === 'local' — operate locally
    return { redirected: false }
  }

  return {
    redirected: true,
    rule,
    resolved,
  }
}
