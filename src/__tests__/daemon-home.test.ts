/**
 * Regression test for daemon home resolution.
 *
 * Bug: in a git repo the daemon runs in multi-location mode with its lock/socket
 * under `<git-common-dir>/opentasks`, but the CLI's daemon probes used the plain
 * `.opentasks` path. As a result auto-start "timed out" (~11s + a scary error on a
 * user's first command), and `daemon status`/`daemon stop` couldn't see the running
 * daemon. `daemonHomeFor` must mirror `cmdDaemonStart`'s single-vs-multi decision.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { daemonHomeFor } from '../cli.js';

describe('daemonHomeFor', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-daemon-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves to <git-common-dir>/opentasks inside a git repo (the multi-location daemon home)', () => {
    execSync('git init -q', { cwd: tmp });
    const opentasksDir = path.join(tmp, '.opentasks');
    fs.mkdirSync(opentasksDir);

    const home = daemonHomeFor(opentasksDir);

    // The daemon lives under .git/opentasks, NOT the plain .opentasks dir.
    expect(path.basename(home)).toBe('opentasks');
    expect(path.basename(path.dirname(home))).toBe('.git');
    expect(home).not.toBe(opentasksDir);
  });

  it('resolves to the location dir itself when not in a git repo', () => {
    const opentasksDir = path.join(tmp, '.opentasks');
    fs.mkdirSync(opentasksDir);

    expect(daemonHomeFor(opentasksDir)).toBe(opentasksDir);
  });
});
