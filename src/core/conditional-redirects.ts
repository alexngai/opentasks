/**
 * Conditional Redirect Rules for OpenTasks (Phase 3)
 *
 * Extends Phase 2 redirect rules with role and branch conditions.
 */

import type { RedirectRule, RedirectOperation } from './redirects.js'
import { matchPattern } from './redirects.js'

/**
 * Conditions for when a redirect rule applies
 */
export interface RedirectCondition {
  /** Role condition (exact match) */
  role?: string
  /** Branch condition (glob pattern) */
  branch?: string
}

/**
 * Extended redirect rule with conditions
 */
export interface ConditionalRedirectRule extends RedirectRule {
  /** Conditions that must be met for this rule to apply */
  when?: RedirectCondition
}

/**
 * Runtime context for evaluating redirect conditions
 */
export interface RedirectContext {
  /** Current location role */
  role: string
  /** Current git branch (cached) */
  branch?: string
}

/**
 * Simple glob match for branch patterns
 *
 * Supports: "feature-*", "main", "*"
 */
function branchMatch(pattern: string, branch: string): boolean {
  if (pattern === '*') return true

  if (pattern.endsWith('*')) {
    return branch.startsWith(pattern.slice(0, -1))
  }

  if (pattern.startsWith('*')) {
    return branch.endsWith(pattern.slice(1))
  }

  return pattern === branch
}

/**
 * Check if conditions are met
 */
export function evaluateConditions(
  conditions: RedirectCondition | undefined,
  context: RedirectContext
): boolean {
  if (!conditions) return true

  if (conditions.role && conditions.role !== context.role) {
    return false
  }

  if (conditions.branch) {
    if (!context.branch) return false
    if (!branchMatch(conditions.branch, context.branch)) return false
  }

  return true
}

/**
 * Find the first matching conditional redirect rule
 *
 * Extends findRedirectRule with condition evaluation.
 */
export function findConditionalRedirectRule(
  operation: RedirectOperation,
  nodeId: string,
  rules: ConditionalRedirectRule[],
  context: RedirectContext
): ConditionalRedirectRule | null {
  // Sort by priority (ascending — lower = higher priority)
  const sorted = [...rules].sort((a, b) => a.priority - b.priority)

  for (const rule of sorted) {
    if (!rule.operations.includes(operation)) continue
    if (!matchPattern(rule.pattern, nodeId)) continue
    if (!evaluateConditions(rule.when, context)) continue
    return rule
  }

  return null
}
