/**
 * Core utilities for OpenTasks
 *
 * @packageDocumentation
 */

// ID generation
export {
  generateId,
  generateIdFromUuid,
  typePrefix,
  adaptiveLength,
  hexToBase36,
  parseIdPrefix,
  inferTypeFromId,
  type IdNodeType,
  type GeneratedId,
} from './id.js'

// Content hashing
export { sha256, computeContentHash, contentEqual } from './hash.js'
