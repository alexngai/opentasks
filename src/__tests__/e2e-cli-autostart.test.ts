/**
 * E2E: CLI daemon auto-start + detached `daemon start` (P4 4.1 / 4.2).
 *
 * Spawns the built `dist/cli.js` as a real subprocess in a throwaway temp dir to
 * prove the cold-start path: a daemon-requiring command auto-starts a detached
 * daemon, and `daemon start` detaches by default. Skipped when dist isn't built
 * (run `npm run build` first).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(fileURLToPath(import.meta.url), '../../../dist/cli.js');
const distBuilt = existsSync(CLI);

function run(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  // The CLI only runs `main()` when VITEST is unset (so importing it for tests
  // doesn't execute it). The subprocess inherits our env, so strip VITEST or the
  // spawned CLI — and the daemon it spawns — would do nothing.
  const env = { ...process.env };
  delete env.VITEST;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status ?? 1,
  };
}

describe.skipIf(!distBuilt)('E2E: CLI cold-start (4.1 / 4.2)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-cli-coldstart-'));
  });

  afterEach(async () => {
    // Best-effort: stop any daemon this test started, then clean up.
    run(tempDir, ['daemon', 'stop']);
    await new Promise((r) => setTimeout(r, 400));
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('auto-starts the daemon on the first daemon-requiring command', () => {
    run(tempDir, ['init']);

    const created = run(tempDir, ['create', '--type', 'task', '--title', 'Cold start', '--status', 'open']);
    expect(created.status).toBe(0);
    const node = JSON.parse(created.stdout);
    expect(node.id).toBeTruthy();
    // The auto-start notice goes to stderr, not stdout.
    expect(created.stderr).toContain('daemon');

    const ready = run(tempDir, ['query', '{"ready":{}}']);
    expect(ready.status).toBe(0);
    const parsed = JSON.parse(ready.stdout);
    const items: Array<{ title?: string }> = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    expect(items.some((n) => n.title === 'Cold start')).toBe(true);
  }, 30_000);

  it('`daemon start` detaches by default and returns once up', () => {
    run(tempDir, ['init']);

    const started = run(tempDir, ['daemon', 'start']);
    expect(started.status).toBe(0);
    const out = JSON.parse(started.stdout);
    expect(out.status).toBe('started');
    expect(out.detached).toBe(true);
    expect(out.pid).toBeTruthy();

    // A second start reports already_running (not a second daemon).
    const again = run(tempDir, ['daemon', 'start']);
    expect(JSON.parse(again.stdout).status).toBe('already_running');
  }, 30_000);

  it('--no-autostart skips auto-start (command fails cleanly, no daemon spawned)', () => {
    run(tempDir, ['init']);

    const res = run(tempDir, [
      'create',
      '--type',
      'task',
      '--title',
      'x',
      '--status',
      'open',
      '--no-autostart',
    ]);
    expect(res.status).not.toBe(0);

    // No daemon should be running afterward.
    const status = run(tempDir, ['daemon', 'status']);
    // `daemon status` exits non-zero / reports not running when none exists.
    const notRunning =
      status.status !== 0 || /not_running|"running":\s*false/.test(status.stdout + status.stderr);
    expect(notRunning).toBe(true);
  }, 30_000);
});

describe.skipIf(!distBuilt)('E2E: CLI human commands (4.4)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-cli-views-'));
  });

  afterEach(async () => {
    run(tempDir, ['daemon', 'stop']);
    await new Promise((r) => setTimeout(r, 400));
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function create(title: string, status = 'open'): string {
    const r = run(tempDir, ['create', '--type', 'task', '--title', title, '--status', status]);
    return JSON.parse(r.stdout).id as string;
  }

  it('ready / list / blocked / tree render compact, closed-excluded views', () => {
    run(tempDir, ['init']);
    create('Alpha');
    const beta = create('Beta');
    const blocker = create('Gamma');
    run(tempDir, ['link', '--from', blocker, '--to', beta, '--type', 'blocks']);
    create('Omega', 'closed');

    // ready: unblocked only — Beta (blocked) excluded.
    const ready = run(tempDir, ['ready']);
    expect(ready.status).toBe(0);
    expect(ready.stdout).toContain('Alpha');
    expect(ready.stdout).toContain('Gamma');
    expect(ready.stdout).not.toContain('Beta');

    // list: closed hidden by default; --all shows it.
    const list = run(tempDir, ['list']);
    expect(list.stdout).toContain('Alpha');
    expect(list.stdout).not.toContain('Omega');
    expect(run(tempDir, ['list', '--all']).stdout).toContain('Omega');

    // blocked: Beta is waiting on Gamma.
    const blocked = run(tempDir, ['blocked']);
    expect(blocked.stdout).toContain(beta);
    expect(blocked.stdout).not.toContain('Alpha');

    // tree: Beta → its blocker Gamma.
    const tree = run(tempDir, ['tree', beta]);
    expect(tree.stdout).toContain(beta);
    expect(tree.stdout).toContain(blocker);
  }, 30_000);

  it('cleanup archives terminal tasks older than the TTL (dry-run is non-destructive)', () => {
    run(tempDir, ['init']);
    create('Active');
    create('Finished', 'closed');

    // dry-run reports candidates but changes nothing.
    const dry = run(tempDir, ['cleanup', '--dry-run', '--older-than-days', '0']);
    expect(JSON.parse(dry.stdout).wouldArchive).toBe(1);
    expect(run(tempDir, ['list', '--all']).stdout).toContain('Finished');

    // a 30-day TTL spares the just-created closed task.
    expect(JSON.parse(run(tempDir, ['cleanup', '--older-than-days', '30']).stdout).archived).toBe(0);

    // a 0-day TTL archives it → it drops out of listings, the open task stays.
    expect(JSON.parse(run(tempDir, ['cleanup', '--older-than-days', '0']).stdout).archived).toBe(1);
    const after = run(tempDir, ['list', '--all']).stdout;
    expect(after).not.toContain('Finished');
    expect(after).toContain('Active');
  }, 30_000);
});

describe.skipIf(!distBuilt)('E2E: CLI --global store (4.7)', () => {
  let fakeHome: string;
  let work1: string;
  let work2: string;

  // Run with an isolated HOME so the real ~/.opentasks is never touched.
  function runG(cwd: string, args: string[]) {
    const env = { ...process.env, HOME: fakeHome };
    delete env.VITEST;
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-ghome-'));
    work1 = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-gw1-'));
    work2 = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-gw2-'));
  });

  afterEach(async () => {
    runG(work1, ['daemon', 'stop', '--global']);
    await new Promise((r) => setTimeout(r, 400));
    for (const d of [fakeHome, work1, work2]) {
      try {
        await fs.rm(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('--global routes use-from-anywhere to ~/.opentasks (not cwd-local)', () => {
    expect(runG(work1, ['init', '--global']).stdout).toContain('global');

    // Create from one dir, read from a different dir — both via --global.
    const created = runG(work1, ['create', '--type', 'task', '--title', 'Roaming', '--status', 'open', '--global']);
    expect(created.status).toBe(0);

    const list = runG(work2, ['list', '--global']);
    expect(list.stdout).toContain('Roaming');

    // No local store should have been created in either working dir.
    expect(existsSync(path.join(work1, '.opentasks'))).toBe(false);
    expect(existsSync(path.join(work2, '.opentasks'))).toBe(false);
  }, 30_000);
});
