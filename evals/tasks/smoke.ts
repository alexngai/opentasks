import type { EvalTask } from '../types.js';

/**
 * Trivial multi-step task to validate the harness end-to-end (spawn → tool
 * calls → token accounting → ground-truth checkpoints → trace). NOT a real
 * eval task; just exercises the pipeline before TheAgentCompany lands.
 */
export const SMOKE_TASK: EvalTask = {
  id: 'smoke-greeting',
  prompt:
    'In the current working directory, do two things: (1) create a file named greeting.txt whose ' +
    'entire contents are exactly the single word: hello  (2) create a file summary.md that briefly ' +
    'records what you did. Keep working until BOTH files exist, then stop.',
  checkpoints: [
    { id: 'greeting-exists', weight: 1, check: { type: 'fileExists', path: 'greeting.txt' } },
    { id: 'greeting-content', weight: 1, check: { type: 'fileContains', path: 'greeting.txt', pattern: '^\\s*hello\\s*$' } },
    { id: 'summary-exists', weight: 1, check: { type: 'fileExists', path: 'summary.md' } },
  ],
};
