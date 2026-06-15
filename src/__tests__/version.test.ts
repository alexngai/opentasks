/**
 * Version consistency guard (P0 hardening).
 *
 * All version surfaces — CLI help banner, daemon serverInfo, MCP serverInfo —
 * must derive from a single source (`src/version.ts`, which reads package.json).
 * This test fails if anyone reintroduces a hardcoded version literal in the
 * known surfaces, which previously produced three conflicting versions in one
 * binary (help "0.1.0" / daemon+MCP "0.0.5" / package "0.1.3").
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERSION } from '../version.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

describe('version consistency', () => {
  it('VERSION matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('VERSION is a valid semver', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('CLI source has no hardcoded version literal', () => {
    const cli = readFileSync(join(here, '..', 'cli.ts'), 'utf-8');
    // The help banner must interpolate VERSION, not a literal.
    expect(cli).toContain('opentasks v${VERSION}');
    expect(cli).not.toMatch(/opentasks v\d+\.\d+\.\d+/);
    expect(cli).not.toMatch(/const version = '\d+\.\d+\.\d+'/);
  });

  it('MCP server source has no hardcoded version literal', () => {
    const mcp = readFileSync(join(here, '..', 'mcp', 'server.ts'), 'utf-8');
    expect(mcp).toContain('version: VERSION');
    expect(mcp).not.toMatch(/version: '\d+\.\d+\.\d+'/);
  });
});
