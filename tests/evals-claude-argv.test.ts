/**
 * WK-0237 slice A — pins `buildClaudeArgv`'s full argv order (scope 2, 17.2,
 * 18.1).
 */
import { describe, expect, it } from 'vitest';

import { buildClaudeArgv, DEFAULT_BUDGET_USD, EVAL_ALLOWED_TOOLS, EVAL_DISALLOWED_TOOLS } from '../evals/claude-argv.js';

describe('buildClaudeArgv', () => {
  it('pins the full argv for a representative input', () => {
    const argv = buildClaudeArgv({
      prompt: 'WK-0237 scenario text',
      model: 'claude-opus-5-5',
      mcpConfigPath: '/home/eval/mcp-config.json',
    });

    expect(argv).toEqual([
      '-p', 'WK-0237 scenario text',
      '--model', 'claude-opus-5-5',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-budget-usd', '2',
      '--allowedTools', EVAL_ALLOWED_TOOLS.join(','),
      '--disallowedTools', EVAL_DISALLOWED_TOOLS,
      '--mcp-config', '/home/eval/mcp-config.json',
      '--strict-mcp-config',
    ]);
  });

  it('carries the scope 17.2 allowed-tools list exactly, unscoped', () => {
    expect(EVAL_ALLOWED_TOOLS).toEqual([
      'mcp__kb-wiki__*', 'Task', 'Skill', 'WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob', 'Edit', 'Write',
    ]);
  });

  it('carries the exact scope 5 --disallowedTools pattern', () => {
    expect(EVAL_DISALLOWED_TOOLS).toBe('Bash(git push:*)');
  });

  it('defaults --max-budget-usd to 2 (scope 18.1) and omits --model when not given', () => {
    const argv = buildClaudeArgv({ prompt: 'x', mcpConfigPath: '/home/eval/mcp-config.json' });
    expect(argv).not.toContain('--model');
    expect(DEFAULT_BUDGET_USD).toBe(2);
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('2');
  });

  it('honors an explicit budgetUsd override', () => {
    const argv = buildClaudeArgv({ prompt: 'x', budgetUsd: 5, mcpConfigPath: '/home/eval/mcp-config.json' });
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('5');
  });
});
