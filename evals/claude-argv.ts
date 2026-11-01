/**
 * `claude -p` argv builder (WK-0237 scope 2, 17.2, 17.3, 18.1). Pure and
 * synchronous — assembles an argument array, same "cannot fail" contract as
 * jail.ts's `buildEvalJailArgs`.
 */

/** scope 17.2 (Resolutions 6, 8): the full planner-eval seat surface, unscoped. */
export const EVAL_ALLOWED_TOOLS: readonly string[] = [
  'mcp__kb-wiki__*',
  'Task',
  'Skill',
  'WebSearch',
  'WebFetch',
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
];

/** `--disallowedTools` stays only as a measured signal (scope 5), not a boundary. */
export const EVAL_DISALLOWED_TOOLS = 'Bash(git push:*)';

/** scope 18.1: every run passes `--max-budget-usd 2` unless overridden. */
export const DEFAULT_BUDGET_USD = 2;

export interface ClaudeArgvOpts {
  prompt: string;
  /** Per-run harness input (scope 12) — omitted entirely when not given, so the CLI's own default model applies. */
  model?: string;
  /** Default 2 (scope 18.1). */
  budgetUsd?: number;
  /** Jail-side path to the per-run MCP config (mcp-config.ts). */
  mcpConfigPath: string;
}

/** Builds the `claude -p` argv (excluding the binary itself). */
export function buildClaudeArgv(opts: ClaudeArgvOpts): string[] {
  const argv: string[] = ['-p', opts.prompt];
  if (opts.model !== undefined) {
    argv.push('--model', opts.model);
  }
  argv.push('--output-format', 'stream-json');
  argv.push('--verbose');
  argv.push('--max-budget-usd', String(opts.budgetUsd ?? DEFAULT_BUDGET_USD));
  argv.push('--allowedTools', EVAL_ALLOWED_TOOLS.join(','));
  argv.push('--disallowedTools', EVAL_DISALLOWED_TOOLS);
  argv.push('--mcp-config', opts.mcpConfigPath);
  argv.push('--strict-mcp-config');
  return argv;
}
