/**
 * Integration tests for Claude Tasks Provider with Filesystem Store
 *
 * Tests the full stack: provider interface → filesystem store → disk.
 * No mocking — uses real temp directories and real file I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createClaudeTasksProvider } from '../claude-tasks.js';
import { createFilesystemTaskStore } from '../claude-tasks-fs.js';
import type { Provider } from '../types.js';
import type { ClaudeTask } from '../claude-tasks.js';

describe('Claude Tasks Provider + Filesystem Store Integration', () => {
  let tmpDir: string;
  let provider: Provider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tasks-integ-'));
    const taskStore = createFilesystemTaskStore({ basePath: tmpDir });
    provider = createClaudeTasksProvider({ taskStore });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // 1. Full CRUD round-trip
  // ==========================================================================

  describe('full CRUD round-trip', () => {
    it('should create a task and return a ProviderNode with correct fields', async () => {
      const result = await provider.create({
        type: 'issue',
        title: 'Fix bug',
        content: 'Details...',
      });

      expect(result.type).toBe('task');
      expect(result.title).toBe('Fix bug');
      expect(result.content).toBe('Details...');
      expect(result.status).toBe('open');
      expect(result.id).toBeDefined();
      expect(result.uri).toContain('claude://current/');
      expect(result.priority).toBe(2);
      expect(result.fetchedAt).toBeDefined();
    });

    it('should persist the task as a JSON file on disk', async () => {
      const result = await provider.create({
        type: 'issue',
        title: 'Fix bug',
        content: 'Details...',
      });

      const filePath = path.join(tmpDir, `${result.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ClaudeTask;
      // File uses Claude format: "subject" not "title"
      expect(fileContent.subject).toBe('Fix bug');
      expect(fileContent.description).toBe('Details...');
      expect(fileContent.status).toBe('pending');
      expect(fileContent.id).toBe(result.id);
    });

    it('should get a task by full URI', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'Fix bug',
        content: 'Details...',
      });

      const fetched = await provider.get(`claude://current/${created.id}`);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.title).toBe('Fix bug');
      expect(fetched!.content).toBe('Details...');
    });

    it('should update a task and persist the change to disk', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'Fix bug',
        status: 'open',
      });

      const updated = await provider.update(`claude://current/${created.id}`, {
        status: 'closed',
      });

      expect(updated.status).toBe('closed');

      // Verify file on disk has the Claude-format status
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tmpDir, `${created.id}.json`), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('completed');
    });

    it('should list all tasks', async () => {
      await provider.create({ type: 'issue', title: 'Task 1' });
      await provider.create({ type: 'issue', title: 'Task 2' });
      await provider.create({ type: 'issue', title: 'Task 3' });

      const tasks = await provider.list();
      expect(tasks).toHaveLength(3);
    });

    it('should delete a task and remove the file from disk', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'Task to delete',
      });

      const filePath = path.join(tmpDir, `${created.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      await provider.delete(`claude://current/${created.id}`);

      expect(fs.existsSync(filePath)).toBe(false);
      const fetched = await provider.get(created.id);
      expect(fetched).toBeNull();
    });
  });

  // ==========================================================================
  // 2. Status mapping round-trip through provider + filesystem
  // ==========================================================================

  describe('status mapping round-trip', () => {
    it('should default to pending on disk and open via provider', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'New task',
      });

      // Provider returns "open"
      expect(created.status).toBe('open');

      // File on disk has "pending"
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tmpDir, `${created.id}.json`), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('pending');
    });

    it('should map in_progress correctly in both directions', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'Task',
        status: 'in_progress',
      });

      expect(created.status).toBe('in_progress');

      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tmpDir, `${created.id}.json`), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('in_progress');
    });

    it('should map closed to completed on disk', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'Task',
        status: 'open',
      });

      await provider.update(created.id, { status: 'closed' });

      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tmpDir, `${created.id}.json`), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('completed');

      // Verify it reads back as "closed" through the provider
      const fetched = await provider.get(created.id);
      expect(fetched!.status).toBe('closed');
    });
  });

  // ==========================================================================
  // 3. External writes (simulating Claude Code writing task files)
  // ==========================================================================

  describe('external writes', () => {
    it('should read tasks written directly to disk', async () => {
      // Simulate Claude Code writing a task file directly
      const externalTask: ClaudeTask = {
        id: '1',
        subject: 'From Claude',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, '1.json'),
        JSON.stringify(externalTask, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tmpDir, '.highwatermark'), '1', 'utf-8');

      // Create a fresh provider pointing at the same directory
      const store = createFilesystemTaskStore({ basePath: tmpDir });
      const freshProvider = createClaudeTasksProvider({ taskStore: store });

      // Should be able to get the externally-written task
      const fetched = await freshProvider.get('1');
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe('1');
      // "subject" in the file becomes "title" in the provider
      expect(fetched!.title).toBe('From Claude');
      expect(fetched!.status).toBe('open'); // pending → open

      // Should appear in list
      const tasks = await freshProvider.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('From Claude');
    });

    it('should include rawData with original Claude task fields', async () => {
      const externalTask: ClaudeTask = {
        id: '1',
        subject: 'From Claude',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, '1.json'),
        JSON.stringify(externalTask, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tmpDir, '.highwatermark'), '1', 'utf-8');

      const store = createFilesystemTaskStore({ basePath: tmpDir });
      const freshProvider = createClaudeTasksProvider({ taskStore: store });

      const fetched = await freshProvider.get('1');
      expect(fetched!.rawData).toMatchObject({
        subject: 'From Claude',
        blocks: [],
        blockedBy: [],
      });
    });
  });

  // ==========================================================================
  // 4. Concurrent access (provider creates + external writes)
  // ==========================================================================

  describe('concurrent access', () => {
    it('should see both provider-created and externally-written tasks', async () => {
      // Create a task via provider (gets id "1")
      const created = await provider.create({
        type: 'issue',
        title: 'Provider task',
      });
      expect(created.id).toBe('1');

      // Write another task file directly to disk (simulating Claude)
      const externalTask: ClaudeTask = {
        id: '2',
        subject: 'External task',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, '2.json'),
        JSON.stringify(externalTask, null, 2),
        'utf-8',
      );
      // Update highwatermark to reflect the external write
      fs.writeFileSync(path.join(tmpDir, '.highwatermark'), '2', 'utf-8');

      // List should return both tasks sorted by ID
      const tasks = await provider.list();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe('1');
      expect(tasks[0].title).toBe('Provider task');
      expect(tasks[1].id).toBe('2');
      expect(tasks[1].title).toBe('External task');
    });

    it('should increment from updated highwatermark after external write', async () => {
      // Create first task via provider
      await provider.create({ type: 'issue', title: 'Task 1' });

      // External write of task 2
      const externalTask: ClaudeTask = {
        id: '2',
        subject: 'External',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tmpDir, '2.json'),
        JSON.stringify(externalTask, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tmpDir, '.highwatermark'), '2', 'utf-8');

      // Next provider create should get id "3"
      const task3 = await provider.create({ type: 'issue', title: 'Task 3' });
      expect(task3.id).toBe('3');

      const tasks = await provider.list();
      expect(tasks).toHaveLength(3);
    });
  });

  // ==========================================================================
  // 5. URI parsing with filesystem store
  // ==========================================================================

  describe('URI parsing with filesystem store', () => {
    it('should access a task using bare ID', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'URI test',
      });

      const fetched = await provider.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('URI test');
    });

    it('should access a task using claude:// URI', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'URI test',
      });

      const fetched = await provider.get(`claude://current/${created.id}`);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('URI test');
    });

    it('should access a task using task:// URI', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'URI test',
      });

      const fetched = await provider.get(`task://current/${created.id}`);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('URI test');
    });

    it('should return consistent data across all URI formats', async () => {
      const created = await provider.create({
        type: 'issue',
        title: 'URI test',
        content: 'Some content',
      });

      const byId = await provider.get(created.id);
      const byClaude = await provider.get(`claude://current/${created.id}`);
      const byTask = await provider.get(`task://current/${created.id}`);

      // All should return the same core data
      expect(byId!.id).toBe(byClaude!.id);
      expect(byId!.id).toBe(byTask!.id);
      expect(byId!.title).toBe(byClaude!.title);
      expect(byId!.title).toBe(byTask!.title);
      expect(byId!.content).toBe(byClaude!.content);
      expect(byId!.content).toBe(byTask!.content);
    });
  });

  // ==========================================================================
  // 6. Provider capabilities and metadata
  // ==========================================================================

  describe('provider capabilities and metadata', () => {
    it('should have read capability', () => {
      expect(provider.capabilities.read).toBe(true);
    });

    it('should have write capability', () => {
      expect(provider.capabilities.write).toBe(true);
    });

    it('should have correct name', () => {
      expect(provider.name).toBe('claude');
    });

    it('should include claude and task schemes', () => {
      expect(provider.schemes).toContain('claude');
      expect(provider.schemes).toContain('task');
    });

    it('should have all expected capabilities', () => {
      expect(provider.capabilities).toEqual({
        read: true,
        write: true,
        search: false,
        watch: false,
        mount: true,
        feedback: false,
      });
    });
  });
});
