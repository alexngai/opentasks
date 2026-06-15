/**
 * Single source of truth for the package version.
 *
 * Reads `version` from the nearest `opentasks` package.json by walking up from
 * this module's location. Works in both the compiled layout (`dist/version.js`
 * → `../package.json`) and when running from source under vitest
 * (`src/version.ts` → `../package.json`), as well as when installed under
 * `node_modules/opentasks/`.
 *
 * Do NOT hardcode version strings anywhere else — import `VERSION` from here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function resolveVersion(): string {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return '0.0.0';
  }

  // Walk up looking for our own package.json. The name guard prevents picking
  // up a dependency's manifest if the directory layout is unexpected.
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (pkg?.name === 'opentasks' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // No package.json here (or unreadable) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return '0.0.0';
}

/** The current opentasks package version (e.g. "0.1.3"). */
export const VERSION = resolveVersion();
