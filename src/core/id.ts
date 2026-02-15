/**
 * ID generation for OpenTasks
 *
 * Uses hash-based IDs with type prefixes for collision resistance
 * in multi-agent/multi-threaded environments.
 */

import { createHash, randomUUID } from 'node:crypto';

/**
 * Node type for ID generation
 */
export type IdNodeType = 'context' | 'task' | 'feedback' | 'external' | 'edge';

/**
 * ID prefixes by type
 */
const TYPE_PREFIXES: Record<IdNodeType, string> = {
  context: 'c',
  task: 't',
  feedback: 'f',
  external: 'e',
  edge: 'x',
};

/**
 * Base36 character set (0-9, a-z)
 */
const BASE36_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Convert a hex string to base36
 */
export function hexToBase36(hex: string): string {
  // Convert hex to BigInt, then to base36
  const num = BigInt('0x' + hex);
  let result = '';
  let remaining = num;

  if (remaining === 0n) return '0';

  while (remaining > 0n) {
    const digit = Number(remaining % 36n);
    result = BASE36_CHARS[digit] + result;
    remaining = remaining / 36n;
  }

  return result;
}

/**
 * Get the type prefix for a node type
 */
export function typePrefix(type: IdNodeType | string): string {
  return TYPE_PREFIXES[type as IdNodeType] || 'n';
}

/**
 * Calculate adaptive ID length based on entity count
 *
 * Uses birthday paradox to target <1% collision probability.
 *
 * For base36 (36 characters):
 * - 4 chars: 36^4 = 1,679,616 possibilities → safe up to ~980 entities
 * - 5 chars: 36^5 = 60,466,176 possibilities → safe up to ~5,900 entities
 * - 6 chars: 36^6 = 2,176,782,336 possibilities → safe up to ~35,000 entities
 * - 7 chars: 36^7 = 78,364,164,096 possibilities → safe up to ~212,000 entities
 * - 8 chars: 36^8 = 2,821,109,907,456 possibilities → safe up to ~1.3M entities
 */
export function adaptiveLength(count: number): number {
  if (count < 980) return 4;
  if (count < 5900) return 5;
  if (count < 35000) return 6;
  if (count < 212000) return 7;
  return 8;
}

/**
 * Result of ID generation
 */
export interface GeneratedId {
  /** Short hash-based ID (e.g., "s-a2b3") */
  id: string;
  /** Full UUID v4 */
  uuid: string;
}

/**
 * Generate a new ID for a node
 *
 * @param type - The node type (determines prefix)
 * @param existingCount - Number of existing entities (for adaptive length)
 * @returns Object with short id and full uuid
 *
 * @example
 * ```ts
 * const { id, uuid } = generateId('task')
 * // id: "t-x7k9"
 * // uuid: "550e8400-e29b-41d4-a716-446655440000"
 * ```
 */
export function generateId(type: IdNodeType | string, existingCount: number = 0): GeneratedId {
  // 1. Generate UUID v4
  const uuid = randomUUID();

  // 2. SHA256 hash the UUID
  const hash = createHash('sha256').update(uuid).digest('hex');

  // 3. Convert to base36
  const base36 = hexToBase36(hash);

  // 4. Get adaptive length
  const length = adaptiveLength(existingCount);

  // 5. Prepend type prefix
  const prefix = typePrefix(type);
  const id = `${prefix}-${base36.slice(0, length)}`;

  return { id, uuid };
}

/**
 * Generate an ID from a specific UUID (for deterministic testing)
 *
 * @param type - The node type
 * @param uuid - The UUID to use
 * @param existingCount - Number of existing entities
 * @returns Object with short id and the provided uuid
 */
export function generateIdFromUuid(
  type: IdNodeType | string,
  uuid: string,
  existingCount: number = 0,
): GeneratedId {
  const hash = createHash('sha256').update(uuid).digest('hex');
  const base36 = hexToBase36(hash);
  const length = adaptiveLength(existingCount);
  const prefix = typePrefix(type);
  const id = `${prefix}-${base36.slice(0, length)}`;

  return { id, uuid };
}

/**
 * Parse an ID to extract its type prefix
 *
 * @param id - The ID to parse (e.g., "s-a2b3")
 * @returns The type prefix or null if invalid format
 */
export function parseIdPrefix(id: string): string | null {
  const match = id.match(/^([a-z])-/);
  return match ? match[1] : null;
}

/**
 * Infer node type from ID prefix
 *
 * @param id - The ID to check
 * @returns The inferred node type or null if unknown
 */
export function inferTypeFromId(id: string): IdNodeType | null {
  const prefix = parseIdPrefix(id);
  if (!prefix) return null;

  const prefixToType: Record<string, IdNodeType> = {
    c: 'context',
    t: 'task',
    f: 'feedback',
    e: 'external',
    x: 'edge',
  };

  return prefixToType[prefix] || null;
}
