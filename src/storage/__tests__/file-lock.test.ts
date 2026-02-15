import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileLock, withFileLock } from '../file-lock.js';

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-lock-test-'));
  lockPath = path.join(tmpDir, 'write.lock');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileLock', () => {
  it('acquires and releases lock', async () => {
    const lock = new FileLock({ lockPath });

    await lock.acquire();
    expect(lock.isLocked).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);

    lock.release();
    expect(lock.isLocked).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('throws when acquiring already-acquired lock', async () => {
    const lock = new FileLock({ lockPath });

    await lock.acquire();
    await expect(lock.acquire()).rejects.toThrow('Lock already acquired');

    lock.release();
  });

  it('blocks until lock is released', async () => {
    const lock1 = new FileLock({ lockPath, timeout: 2000 });
    const lock2 = new FileLock({ lockPath, timeout: 2000 });

    await lock1.acquire();

    // Release after 100ms
    setTimeout(() => lock1.release(), 100);

    // lock2 should block then succeed
    await lock2.acquire();
    expect(lock2.isLocked).toBe(true);

    lock2.release();
  });

  it('times out when lock is held', async () => {
    const lock1 = new FileLock({ lockPath, timeout: 5000 });
    const lock2 = new FileLock({ lockPath, timeout: 200, retryInterval: 50 });

    await lock1.acquire();

    await expect(lock2.acquire()).rejects.toThrow('Failed to acquire lock');

    lock1.release();
  });

  it('detects and breaks stale locks', async () => {
    // Create a stale lock file with a non-existent PID
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `999999999\n${Date.now() - 60000}\n`);

    const lock = new FileLock({ lockPath, staleTimeout: 1000 });
    await lock.acquire();
    expect(lock.isLocked).toBe(true);

    lock.release();
  });

  it('release is idempotent', async () => {
    const lock = new FileLock({ lockPath });

    await lock.acquire();
    lock.release();
    lock.release(); // Should not throw
    expect(lock.isLocked).toBe(false);
  });
});

describe('withFileLock', () => {
  it('executes function while holding lock', async () => {
    let executed = false;

    await withFileLock(lockPath, async () => {
      executed = true;
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    expect(executed).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releases lock on function error', async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('returns function result', async () => {
    const result = await withFileLock(lockPath, async () => {
      return 42;
    });

    expect(result).toBe(42);
  });
});
