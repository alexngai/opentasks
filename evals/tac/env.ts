const FORWARDED_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'AZURE_API_KEY',
  'AZURE_API_BASE',
  'AZURE_API_VERSION',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_AUTH_MODE',
  'AZURE_OPENAI_RESPONSES_PATH',
  'TAC_GRADER_PROXY',
  'TAC_GRADER_PROXY_HOST',
  'TAC_GRADER_PROXY_PORT',
  'TAC_GRADER_PROXY_MODEL',
  'TAC_GRADER_PROXY_KEY',
  'TAC_GRADER_BEDROCK_MODEL',
  'TAC_GRADER_BEDROCK_REGION',
  'TAC_GRADER_PROXY_STATE_DIR',
  'TAC_GRADER_PROXY_START_TIMEOUT_SEC',
  'LITELLM_API_KEY',
  'LITELLM_BASE_URL',
  'LITELLM_MODEL',
  'TAC_OPENSWARM_MODE',
  'TAC_OPENSWARM_CONCURRENCY',
  'TAC_OPENSWARM_MULTIAGENT_PROMPT',
  'TAC_TEAM_PROTOCOL',
] as const;

export function tacForwardedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const value = source[key];
    if (value) out[key] = value;
  }
  addAzureAliases(out, source);
  return out;
}

function addAzureAliases(out: Record<string, string>, source: NodeJS.ProcessEnv): void {
  const key = firstEnv(source, 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_KEY', 'AZURE_API_KEY');
  if (key) {
    out.AZURE_OPENAI_API_KEY ??= key;
    out.AZURE_OPENAI_KEY ??= key;
    out.AZURE_API_KEY ??= key;
  }

  const endpoint = firstEnv(source, 'AZURE_OPENAI_ENDPOINT', 'AZURE_API_BASE', 'AZURE_OPENAI_BASE_URL');
  if (endpoint) {
    out.AZURE_OPENAI_ENDPOINT ??= endpoint;
    out.AZURE_API_BASE ??= endpoint;
    out.AZURE_OPENAI_BASE_URL ??= endpoint;
  }

  const version = firstEnv(source, 'AZURE_OPENAI_API_VERSION', 'AZURE_API_VERSION');
  if (version) {
    out.AZURE_OPENAI_API_VERSION ??= version;
    out.AZURE_API_VERSION ??= version;
  }
}

function firstEnv(source: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value) return value;
  }
  return undefined;
}
