import { describe, expect, it } from 'vitest';

import { tacForwardedEnv } from '../../evals/tac/env.js';

describe('TAC forwarded environment', () => {
  it('normalizes Azure OpenAI aliases used by openswarm and pool preflights', () => {
    const env = tacForwardedEnv({
      AZURE_API_KEY: 'sk-test',
      AZURE_API_BASE: 'https://azure.example.test/',
      AZURE_API_VERSION: '2025-04-01-preview',
    });

    expect(env).toMatchObject({
      AZURE_API_KEY: 'sk-test',
      AZURE_OPENAI_API_KEY: 'sk-test',
      AZURE_OPENAI_KEY: 'sk-test',
      AZURE_API_BASE: 'https://azure.example.test/',
      AZURE_OPENAI_ENDPOINT: 'https://azure.example.test/',
      AZURE_OPENAI_BASE_URL: 'https://azure.example.test/',
      AZURE_API_VERSION: '2025-04-01-preview',
      AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
    });
  });

  it('does not overwrite explicit Azure aliases when both forms are present', () => {
    const env = tacForwardedEnv({
      AZURE_API_BASE: 'https://legacy.example.test/',
      AZURE_OPENAI_ENDPOINT: 'https://openai.example.test/',
    });

    expect(env.AZURE_API_BASE).toBe('https://legacy.example.test/');
    expect(env.AZURE_OPENAI_ENDPOINT).toBe('https://openai.example.test/');
  });
});
