/**
 * Edge Type Registry for OpenTasks
 *
 * Makes relationship types extensible without code changes.
 * Providers can contribute new edge types at runtime.
 */

/**
 * Definition for an edge type
 */
export interface EdgeTypeDefinition {
  /** Edge type name (e.g., 'blocks', 'implements') */
  name: string;

  /** Human-readable description */
  description: string;

  /** Inverse relationship name (e.g., 'blocks' ↔ 'blocked-by') */
  inverseOf?: string;

  /** Does this edge type affect ready status? */
  affectsReady: boolean;

  /** Edge direction semantics */
  direction: 'directed' | 'undirected';

  /** Which providers support this edge type */
  providers: string[];
}

/**
 * Provider's support level for an edge type
 */
export interface EdgeTypeSupport {
  /** Edge type name */
  type: string;

  /** Can query existing edges of this type */
  canQuery: boolean;

  /** Can create new edges of this type */
  canCreate: boolean;

  /** Can delete edges of this type */
  canDelete: boolean;
}

/**
 * Built-in edge types
 */
export const BUILTIN_EDGE_TYPES: EdgeTypeDefinition[] = [
  {
    name: 'blocks',
    description: 'Source must complete before target can start',
    inverseOf: 'blocked-by',
    affectsReady: true,
    direction: 'directed',
    providers: ['native', 'beads'],
  },
  {
    name: 'blocked-by',
    description: 'Target is blocked by source (inverse of blocks)',
    inverseOf: 'blocks',
    affectsReady: true,
    direction: 'directed',
    providers: ['native', 'beads'],
  },
  {
    name: 'implements',
    description: 'Task implements a context',
    affectsReady: false,
    direction: 'directed',
    providers: ['native'],
  },
  {
    name: 'parent-of',
    description: 'Hierarchical parent relationship',
    inverseOf: 'child-of',
    affectsReady: false,
    direction: 'directed',
    providers: ['native', 'beads'],
  },
  {
    name: 'child-of',
    description: 'Hierarchical child relationship (inverse of parent-of)',
    inverseOf: 'parent-of',
    affectsReady: false,
    direction: 'directed',
    providers: ['native', 'beads'],
  },
  {
    name: 'discovered-from',
    description: 'Found while working on another node',
    affectsReady: false,
    direction: 'directed',
    providers: ['native', 'beads'],
  },
  {
    name: 'related',
    description: 'Loosely associated nodes',
    affectsReady: false,
    direction: 'undirected',
    providers: ['native', 'beads'],
  },
  {
    name: 'references',
    description: 'General reference link',
    affectsReady: false,
    direction: 'directed',
    providers: ['native'],
  },
  {
    name: 'depends-on',
    description: 'Softer dependency than blocks',
    inverseOf: 'dependency-of',
    affectsReady: false,
    direction: 'directed',
    providers: ['native', 'beads'],
  },
  {
    name: 'dependency-of',
    description: 'Inverse of depends-on',
    inverseOf: 'depends-on',
    affectsReady: false,
    direction: 'directed',
    providers: ['native', 'beads'],
  },
  {
    name: 'duplicates',
    description: 'Marks a duplicate of another node',
    affectsReady: false,
    direction: 'directed',
    providers: ['native'],
  },
  {
    name: 'supersedes',
    description: 'Replaces another node',
    affectsReady: false,
    direction: 'directed',
    providers: ['native'],
  },
];

/**
 * Result of looking up an edge type
 */
export interface EdgeTypeLookupResult {
  /** The edge type definition */
  definition: EdgeTypeDefinition;

  /** Whether this is the canonical form (not inverse) */
  isCanonical: boolean;

  /** The canonical edge type name */
  canonicalType: string;
}

/**
 * Edge Type Registry
 *
 * Manages registered edge types and provides lookup functionality.
 * Supports inverse relationships (e.g., blocks ↔ blocked-by).
 */
export class EdgeTypeRegistry {
  private types: Map<string, EdgeTypeDefinition> = new Map();
  private inverses: Map<string, string> = new Map();
  private registrationOrder: string[] = [];

  constructor() {
    // Register built-in types
    for (const type of BUILTIN_EDGE_TYPES) {
      this.register(type);
    }
  }

  /**
   * Register a new edge type
   *
   * @param definition - The edge type definition
   * @throws Error if type already registered with different definition
   */
  register(definition: EdgeTypeDefinition): void {
    const existing = this.types.get(definition.name);
    if (existing) {
      // Allow re-registration with same definition (idempotent)
      if (JSON.stringify(existing) !== JSON.stringify(definition)) {
        throw new Error(
          `Edge type '${definition.name}' already registered with different definition`,
        );
      }
      return;
    }

    this.types.set(definition.name, definition);
    this.registrationOrder.push(definition.name);

    // Track inverse relationships
    if (definition.inverseOf) {
      this.inverses.set(definition.name, definition.inverseOf);
    }
  }

  /**
   * Look up an edge type by name
   *
   * @param name - The edge type name
   * @returns The lookup result or null if not found
   */
  lookup(name: string): EdgeTypeLookupResult | null {
    const definition = this.types.get(name);
    if (!definition) {
      return null;
    }

    // Check if this is an inverse type
    const inverse = definition.inverseOf;
    if (inverse && this.types.has(inverse)) {
      // The canonical form is the one registered first
      const nameIndex = this.registrationOrder.indexOf(name);
      const inverseIndex = this.registrationOrder.indexOf(inverse);
      const isCanonical = nameIndex < inverseIndex;

      return {
        definition,
        isCanonical,
        canonicalType: isCanonical ? name : inverse,
      };
    }

    return {
      definition,
      isCanonical: true,
      canonicalType: name,
    };
  }

  /**
   * Get the inverse of an edge type
   *
   * @param name - The edge type name
   * @returns The inverse type name or null if none
   */
  getInverse(name: string): string | null {
    return this.inverses.get(name) ?? null;
  }

  /**
   * Check if an edge type affects ready status
   *
   * @param name - The edge type name
   * @returns True if this edge type affects ready status
   */
  affectsReady(name: string): boolean {
    const definition = this.types.get(name);
    return definition?.affectsReady ?? false;
  }

  /**
   * Get all registered edge types
   *
   * @returns Array of all edge type definitions
   */
  getAll(): EdgeTypeDefinition[] {
    return Array.from(this.types.values());
  }

  /**
   * Get edge types that affect ready status
   *
   * @returns Array of edge type names that affect ready
   */
  getReadyAffectingTypes(): string[] {
    return this.getAll()
      .filter((t) => t.affectsReady)
      .map((t) => t.name);
  }

  /**
   * Get edge types supported by a provider
   *
   * @param provider - The provider name
   * @returns Array of edge type definitions
   */
  getTypesForProvider(provider: string): EdgeTypeDefinition[] {
    return this.getAll().filter((t) => t.providers.includes(provider));
  }

  /**
   * Check if a type is registered
   *
   * @param name - The edge type name
   * @returns True if the type is registered
   */
  has(name: string): boolean {
    return this.types.has(name);
  }
}

/**
 * Singleton instance of the edge type registry
 */
let globalRegistry: EdgeTypeRegistry | null = null;

/**
 * Get the global edge type registry instance
 *
 * @returns The singleton EdgeTypeRegistry
 */
export function getEdgeTypeRegistry(): EdgeTypeRegistry {
  if (!globalRegistry) {
    globalRegistry = new EdgeTypeRegistry();
  }
  return globalRegistry;
}

/**
 * Create a new edge type registry (for testing)
 *
 * @returns A fresh EdgeTypeRegistry instance
 */
export function createEdgeTypeRegistry(): EdgeTypeRegistry {
  return new EdgeTypeRegistry();
}

/**
 * Reset the global registry (for testing)
 */
export function resetEdgeTypeRegistry(): void {
  globalRegistry = null;
}
