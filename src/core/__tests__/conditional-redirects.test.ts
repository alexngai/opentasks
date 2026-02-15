import { describe, it, expect } from 'vitest';
import {
  evaluateConditions,
  findConditionalRedirectRule,
  type ConditionalRedirectRule,
  type RedirectContext,
} from '../conditional-redirects.js';

describe('evaluateConditions', () => {
  it('returns true for no conditions', () => {
    expect(evaluateConditions(undefined, { role: 'worker' })).toBe(true);
  });

  it('returns true for empty conditions', () => {
    expect(evaluateConditions({}, { role: 'worker' })).toBe(true);
  });

  it('matches role condition', () => {
    expect(evaluateConditions({ role: 'worker' }, { role: 'worker' })).toBe(true);
    expect(evaluateConditions({ role: 'worker' }, { role: 'manager' })).toBe(false);
  });

  it('matches branch condition', () => {
    expect(
      evaluateConditions({ branch: 'feature-*' }, { role: 'worker', branch: 'feature-auth' }),
    ).toBe(true);
    expect(evaluateConditions({ branch: 'feature-*' }, { role: 'worker', branch: 'main' })).toBe(
      false,
    );
  });

  it('matches exact branch', () => {
    expect(evaluateConditions({ branch: 'main' }, { role: 'worker', branch: 'main' })).toBe(true);
    expect(evaluateConditions({ branch: 'main' }, { role: 'worker', branch: 'develop' })).toBe(
      false,
    );
  });

  it('returns false when branch condition set but no branch in context', () => {
    expect(evaluateConditions({ branch: 'main' }, { role: 'worker' })).toBe(false);
  });

  it('matches combined role + branch', () => {
    expect(
      evaluateConditions(
        { role: 'worker', branch: 'feature-*' },
        { role: 'worker', branch: 'feature-auth' },
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        { role: 'worker', branch: 'feature-*' },
        { role: 'manager', branch: 'feature-auth' },
      ),
    ).toBe(false);
  });
});

describe('findConditionalRedirectRule', () => {
  const rules: ConditionalRedirectRule[] = [
    {
      operations: ['write'],
      pattern: 's-*',
      target: 'opentasks://specs/',
      priority: 50,
      fallback: 'error',
      when: { role: 'worker' },
    },
    {
      operations: ['read'],
      pattern: '*',
      target: 'opentasks://main/',
      priority: 100,
      fallback: 'local',
      when: { branch: 'feature-*' },
    },
    {
      operations: ['read', 'write'],
      pattern: '*',
      target: 'opentasks://default/',
      priority: 200,
      fallback: 'local',
    },
  ];

  it('matches rule with role condition', () => {
    const ctx: RedirectContext = { role: 'worker', branch: 'main' };
    const rule = findConditionalRedirectRule('write', 's-abc', rules, ctx);
    expect(rule?.target).toBe('opentasks://specs/');
  });

  it('skips rule when role doesnt match', () => {
    const ctx: RedirectContext = { role: 'manager', branch: 'main' };
    const rule = findConditionalRedirectRule('write', 's-abc', rules, ctx);
    // Should fall through to the default rule
    expect(rule?.target).toBe('opentasks://default/');
  });

  it('matches rule with branch condition', () => {
    const ctx: RedirectContext = { role: 'standalone', branch: 'feature-auth' };
    const rule = findConditionalRedirectRule('read', 'i-abc', rules, ctx);
    expect(rule?.target).toBe('opentasks://main/');
  });

  it('skips branch rule when branch doesnt match', () => {
    const ctx: RedirectContext = { role: 'standalone', branch: 'main' };
    const rule = findConditionalRedirectRule('read', 'i-abc', rules, ctx);
    expect(rule?.target).toBe('opentasks://default/');
  });

  it('matches unconditional fallback', () => {
    const ctx: RedirectContext = { role: 'standalone' };
    const rule = findConditionalRedirectRule('read', 'i-abc', rules, ctx);
    expect(rule?.target).toBe('opentasks://default/');
  });
});
