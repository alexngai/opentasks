/**
 * Hydration E2E Tests
 *
 * Tests the HydratingFederatedGraph's on-demand loading and cache management.
 * Validates that external nodes are properly fetched and cached from providers.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  isBdAvailable,
  BD_SKIP_MESSAGE,
  createBeadsTask,
  createBeadsWorkspace,
  getBeadsTask,
  updateBeadsStatus,
  type E2ESystemContext,
  type BeadsWorkspaceContext,
} from "../../helpers/index.js";

// Check if both agent tests are enabled AND bd is available
const canRunBeadsTests = async () => AGENT_TESTS && (await isBdAvailable());

describe.skipIf(!AGENT_TESTS)("Hydration and Caching", () => {
  let system: E2ESystemContext;
  let beadsAvailable: boolean;
  let sharedWorkspace: BeadsWorkspaceContext | null = null;

  // Create Beads workspace once for all tests in this describe block
  beforeAll(async () => {
    beadsAvailable = await isBdAvailable();
    if (beadsAvailable) {
      const workspaceDir = await mkdtemp(join(tmpdir(), "opentasks-hydration-beads-"));
      sharedWorkspace = await createBeadsWorkspace(workspaceDir, "bd");
    }
  });

  afterAll(async () => {
    // Clean up shared workspace after all tests
    if (sharedWorkspace) {
      await sharedWorkspace.cleanup();
    }
  });

  beforeEach(async () => {
    system = await setupE2ESystem({
      testName: "hydration",
      enableBeads: true,
      cacheTTL: 60000, // 60s TTL - bd CLI is slow, so we need long TTL
      beadsWorkspacePath: sharedWorkspace?.path, // Reuse shared workspace
    });
  });

  afterEach(async () => {
    await system.stop();
  });

  describe("First Access Hydration", () => {
    it("should hydrate external node on first access", async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      // Create a Beads task
      const task = await createBeadsTask(system.beadsWorkspace!, "Test Task", {
        content: "Task description",
        status: "open",
      });

      // Hydrate via the graph
      await system.hydratingGraph.hydrate(task.uri);

      // Verify node is now in the graph
      const hasNode = system.graphologyAdapter.graph.hasNode(task.uri);
      expect(hasNode).toBe(true);

      // Verify node attributes
      const attrs = system.graphologyAdapter.graph.getNodeAttributes(task.uri);
      expect(attrs.title).toBe("Test Task");
      expect(attrs.data).toBeDefined();
    });

    it("should set cached_at timestamp on hydration", async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const task = await createBeadsTask(
        system.beadsWorkspace!,
        "Timestamp Test",
      );
      const beforeHydrate = new Date().toISOString();

      await system.hydratingGraph.hydrate(task.uri);

      const attrs = system.graphologyAdapter.graph.getNodeAttributes(task.uri);
      expect(attrs.cached_at).toBeDefined();

      // cached_at should be after we started
      const cachedAt = new Date(attrs.cached_at!);
      expect(cachedAt.getTime()).toBeGreaterThanOrEqual(
        new Date(beforeHydrate).getTime() - 1000,
      );
    });
  });

  describe("Cache Reuse", () => {
    it("should reuse cached node without re-fetching when fresh", async ({
      skip,
    }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const task = await createBeadsTask(system.beadsWorkspace!, "Cache Test");

      // First hydration
      await system.hydratingGraph.hydrate(task.uri);
      const firstAttrs = system.graphologyAdapter.graph.getNodeAttributes(
        task.uri,
      );
      const firstCachedAt = firstAttrs.cached_at;

      // Immediately hydrate again (should use cache)
      await system.hydratingGraph.hydrate(task.uri);
      const secondAttrs = system.graphologyAdapter.graph.getNodeAttributes(
        task.uri,
      );

      // cached_at should be unchanged (no re-fetch)
      expect(secondAttrs.cached_at).toBe(firstCachedAt);
    });

    it("should not be stale immediately after hydration", async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const task = await createBeadsTask(
        system.beadsWorkspace!,
        "Staleness Test",
      );

      await system.hydratingGraph.hydrate(task.uri);

      // Should not be stale right after hydration
      const isStale = system.hydratingGraph.isStale(task.uri);
      expect(isStale).toBe(false);
    });
  });

  describe("Staleness Detection", () => {
    // Note: Detailed TTL and refresh behavior is unit-tested in the graph layer.
    // E2E tests focus on basic staleness API behavior.

    it("should not be stale immediately after hydration", async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const task = await createBeadsTask(
        system.beadsWorkspace!,
        "Staleness Test",
      );

      await system.hydratingGraph.hydrate(task.uri);

      // With 60s TTL, node should NOT be stale immediately
      const isStale = system.hydratingGraph.isStale(task.uri);
      expect(isStale).toBe(false);
    });

    it("should report non-hydrated nodes as stale", async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      // A node that hasn't been hydrated should be considered stale
      const fakeUri = "beads://./bd-nothydrated";
      const isStale = system.hydratingGraph.isStale(fakeUri);
      expect(isStale).toBe(true);
    });
  });

  describe("Missing Node Handling", () => {
    it("should handle non-existent node gracefully", async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const fakeUri = "beads://./bd-nonexistent99999";

      // Should not throw
      await expect(
        system.hydratingGraph.hydrate(fakeUri),
      ).resolves.not.toThrow();

      // Node should not be in graph
      const hasNode = system.graphologyAdapter.graph.hasNode(fakeUri);
      expect(hasNode).toBe(false);
    });

    it("should return null when resolving non-existent node", async ({
      skip,
    }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const fakeUri = "beads://./bd-nonexistent12345";

      const resolved = await system.hydratingGraph.resolve(fakeUri);
      expect(resolved).toBeNull();
    });
  });

  describe("Concurrent Hydration", () => {
    it("should handle concurrent hydration requests for same node", async ({
      skip,
    }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const task = await createBeadsTask(
        system.beadsWorkspace!,
        "Concurrent Test",
      );

      // Hydrate the same node concurrently from multiple "clients"
      const results = await Promise.all([
        system.hydratingGraph.hydrate(task.uri),
        system.hydratingGraph.hydrate(task.uri),
        system.hydratingGraph.hydrate(task.uri),
      ]);

      // All should complete successfully
      expect(results).toHaveLength(3);

      // Node should be in graph exactly once
      const hasNode = system.graphologyAdapter.graph.hasNode(task.uri);
      expect(hasNode).toBe(true);
    });

    it("should handle concurrent hydration of different nodes", async ({
      skip,
    }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      // Create multiple tasks
      const tasks = await Promise.all([
        createBeadsTask(system.beadsWorkspace!, "Concurrent 1"),
        createBeadsTask(system.beadsWorkspace!, "Concurrent 2"),
        createBeadsTask(system.beadsWorkspace!, "Concurrent 3"),
      ]);

      // Hydrate all concurrently
      await Promise.all(tasks.map((t) => system.hydratingGraph.hydrate(t.uri)));

      // All should be in graph
      for (const task of tasks) {
        const hasNode = system.graphologyAdapter.graph.hasNode(task.uri);
        expect(hasNode).toBe(true);
      }
    });
  });

  describe("Resolve API", () => {
    it("should resolve node with full data", async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const task = await createBeadsTask(
        system.beadsWorkspace!,
        "Resolve Test",
        {
          content: "Detailed description",
          status: "open",
          priority: 1,
        },
      );

      const resolved = await system.hydratingGraph.resolve(task.uri);

      expect(resolved).not.toBeNull();
      expect(resolved!.uri).toBe(task.uri);
      expect(resolved!.provider).toBe("beads");
      expect(resolved!.data.title).toBe("Resolve Test");
      expect(resolved!.cached).toBeDefined();
    });

    it("should batch resolve multiple nodes", async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip();
        return;
      }

      const tasks = await Promise.all([
        createBeadsTask(system.beadsWorkspace!, "Batch 1"),
        createBeadsTask(system.beadsWorkspace!, "Batch 2"),
      ]);

      const uris = tasks.map((t) => t.uri);
      const resolved = await system.hydratingGraph.resolveAll(uris);

      expect(resolved.size).toBe(2);
      for (const uri of uris) {
        expect(resolved.has(uri)).toBe(true);
        expect(resolved.get(uri)!.data.title).toMatch(/Batch/);
      }
    });
  });
});

// If tests are skipped, show appropriate message
if (!AGENT_TESTS) {
  describe("Hydration and Caching (skipped)", () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {});
  });
}
