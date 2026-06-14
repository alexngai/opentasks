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
