/**
 * Tests for computeValueUsage (value-usage.ts).
 *
 * TDD: tests written first, then implementation.
 * Maps to spec §11.7 scenarios.
 *
 * Strategy: inject fake UsageDeps — runCcusage returns canned JSON strings,
 * fetchOpenRouterCredits returns a fake response or null.
 * No network calls, no real ccusage, no real ~/.claude access.
 *
 * Assumed ccusage --json shape (daily --instances):
 * {
 *   daily: Array<{
 *     date: string;               // "YYYY-MM-DD"
 *     projects: Array<{
 *       projectPath: string;      // unencoded cwd, e.g. "C:\Users\mcap9\projects\kb"
 *       models: Array<{
 *         model: string;
 *         input_tokens: number;
 *         cache_creation_input_tokens: number;
 *         cache_read_input_tokens: number;
 *         output_tokens: number;
 *         cost_usd: number;       // ccusage-priced estimate
 *       }>
 *     }>
 *   }>
 * }
 *
 * For the codex tool the shape is the same but with codex session data.
 * Missing/malformed JSON → treat as empty (unavailable path).
 */

import { describe, it, expect, vi } from 'vitest';
import type { UsageDeps } from '../packages/wiki-core/src/value-usage.js';
import { computeValueUsage } from '../packages/wiki-core/src/value-usage.js';

// ---------------------------------------------------------------------------
// Fake deps builder
// ---------------------------------------------------------------------------

const DIR = 'C:\\Users\\mcap9\\projects\\kb';
const SINCE = '2026-07-01';
const UNTIL = '2026-07-10';

/**
 * Build a ccusage JSON payload for the claude tool.
 * Pass a projects array to populate data for the target project.
 */
function makeCcusageJson(
  projects: Array<{
    projectPath: string;
    models: Array<{
      model: string;
      input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>;
  }>,
): string {
  return JSON.stringify({
    daily: [
      {
        date: '2026-07-05',
        projects,
      },
    ],
  });
}

function makeEmptyDeps(): UsageDeps {
  return {
    runCcusage: () => makeCcusageJson([]),
    fetchOpenRouterCredits: async () => null,
  };
}

// ---------------------------------------------------------------------------
// §11.7 — ccusage available path
// ---------------------------------------------------------------------------

describe('ccusage available — subscription arm (claude-*)', () => {
  it('returns tokens from the target project, no dollar amount, provenance subscription-covered', async () => {
    const claudeJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [
          {
            model: 'claude-sonnet-4-5',
            input_tokens: 1000,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
            output_tokens: 500,
            cost_usd: 0.05, // ccusage may price it, but we must NOT use $ for subscription
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    expect(d.input_tokens).toBe(1000);
    expect(d.cache_write_tokens).toBe(200);
    expect(d.cache_read_tokens).toBe(300);
    expect(d.output_tokens).toBe(500);
    expect(d.total_tokens).toBe(2000); // 1000 + 200 + 300 + 500
    expect(d.cost_usd).toBeNull(); // subscription: no dollar estimate
    expect(d.cost_provenance).toBe('subscription-covered');
    expect(d.agents).toContain('claude');
    expect(d.attribution).toBe('date-window-approx');

    // Per-model detail
    expect(d.by_model).toHaveLength(1);
    const model = d.by_model[0];
    expect(model?.model).toBe('claude-sonnet-4-5');
    expect(model?.arm).toBe('subscription');
    expect(model?.cost_usd).toBeNull();
  });
});

describe('ccusage available — local arm (name:tag)', () => {
  it('returns $0 and local-free provenance for qwen3-coder:30b model', async () => {
    const claudeJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [
          {
            model: 'qwen3-coder:30b',
            input_tokens: 500,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 200,
            cost_usd: 0,
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    expect(d.cost_usd).toBe(0);
    expect(d.cost_provenance).toBe('local-free');

    const model = d.by_model[0];
    expect(model?.arm).toBe('local');
    expect(model?.cost_usd).toBe(0);
  });
});

describe('ccusage available — openrouter arm (slash-namespaced)', () => {
  it('uses OR /credits figure when available (openrouter-api provenance)', async () => {
    const claudeJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [
          {
            model: 'z-ai/glm-5.2',
            input_tokens: 800,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 400,
            cost_usd: 0.02, // ccusage estimate — should be overridden by OR credits
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => ({ total_credits: 10.0, total_usage: 0.05 }),
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    expect(d.cost_provenance).toBe('openrouter-api');
    // When OR credits available, cost_usd should come from OR, not ccusage estimate
    // OR total_usage = 0.05 (the authoritative figure)
    expect(d.cost_usd).toBe(0.05);

    const model = d.by_model[0];
    expect(model?.arm).toBe('openrouter');
  });

  it('falls back to ccusage-priced when OpenRouter credits not available', async () => {
    const claudeJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [
          {
            model: 'deepseek/deepseek-chat',
            input_tokens: 600,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 300,
            cost_usd: 0.01,
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    expect(d.cost_provenance).toBe('ccusage-priced');
    expect(d.cost_usd).toBe(0.01); // from ccusage
  });
});

// ---------------------------------------------------------------------------
// §11.7 — mixed arm provenance
// ---------------------------------------------------------------------------

describe('provenance mixed — subscription + openrouter in same window', () => {
  it('sets overall provenance to mixed', async () => {
    const claudeJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [
          {
            model: 'claude-opus-4',
            input_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 400,
            cost_usd: 0.10,
          },
          {
            model: 'z-ai/glm-5.2',
            input_tokens: 500,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 200,
            cost_usd: 0.02,
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_provenance).toBe('mixed');
    expect(result.data.by_model).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §11.7 — self-awareness: absent / empty / errored ccusage
// ---------------------------------------------------------------------------

describe('ccusage absent — throws exception', () => {
  it('returns ok() with unavailable provenance + reason, never fail()', async () => {
    const deps: UsageDeps = {
      runCcusage: () => { throw new Error('npx: command not found'); },
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

    expect(result.ok).toBe(true); // MUST be ok(), not fail()
    if (!result.ok) return;

    expect(result.data.cost_provenance).toBe('unavailable');
    expect(result.data.reason).toBeDefined();
    expect(result.data.reason).toMatch(/ccusage/i);
  });
});

describe('ccusage returns malformed JSON', () => {
  it('returns ok() with unavailable provenance', async () => {
    const deps: UsageDeps = {
      runCcusage: () => 'not json at all',
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_provenance).toBe('unavailable');
    expect(result.data.reason).toBeDefined();
  });
});

describe('ccusage returns empty-for-span (no matching project for dir)', () => {
  it('returns ok() with unavailable provenance + reason', async () => {
    // Data exists but for a different project path
    const claudeJson = makeCcusageJson([
      {
        projectPath: 'C:\\Users\\mcap9\\projects\\other-project',
        models: [
          {
            model: 'claude-sonnet-4-5',
            input_tokens: 999,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 100,
            cost_usd: 0.01,
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_provenance).toBe('unavailable');
    expect(result.data.reason).toBeDefined();
    expect(result.data.total_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §11.7 — instance filtering: only target dir's data is summed
// ---------------------------------------------------------------------------

describe('instance filtering — only target dir entries are counted', () => {
  it('sums tokens only from the instance matching dir (encoded-cwd match)', async () => {
    const claudeJson = makeCcusageJson([
      {
        // Target project
        projectPath: DIR, // C:\Users\mcap9\projects\kb
        models: [
          {
            model: 'claude-sonnet-4-5',
            input_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 500,
            cost_usd: 0.05,
          },
        ],
      },
      {
        // Different project — must NOT be included
        projectPath: 'C:\\Users\\mcap9\\projects\\other',
        models: [
          {
            model: 'claude-sonnet-4-5',
            input_tokens: 9999,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 9999,
            cost_usd: 9.99,
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    // Should only see target dir tokens (1000 + 500 = 1500 total)
    expect(d.input_tokens).toBe(1000);
    expect(d.output_tokens).toBe(500);
    expect(d.total_tokens).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// §11.7 — local arm always $0
// ---------------------------------------------------------------------------

describe('local arm — always $0 regardless of ccusage pricing', () => {
  it('reports cost_usd=0 and local-free even if ccusage would price it', async () => {
    const claudeJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [
          {
            model: 'llama3.2:3b', // name:tag → local
            input_tokens: 2000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1000,
            cost_usd: 0.001, // ccusage might price it; we override to $0
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_usd).toBe(0);
    expect(result.data.cost_provenance).toBe('local-free');
  });
});

// ---------------------------------------------------------------------------
// §11.7 — subscription arm: tokens only, no fabricated dollar figure
// ---------------------------------------------------------------------------

describe('subscription arm — no fabricated dollar figure', () => {
  it('cost_usd is null (not 0, not a number) for pure subscription usage', async () => {
    const claudeJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [
          {
            model: 'claude-haiku-3-5',
            input_tokens: 5000,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 2000,
            output_tokens: 1500,
            cost_usd: 0.50, // ccusage may estimate; we must discard it
          },
        ],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : makeCcusageJson([])),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_usd).toBeNull();
    expect(result.data.cost_provenance).toBe('subscription-covered');
  });
});

// ---------------------------------------------------------------------------
// §11.7 — secrets never logged
// ---------------------------------------------------------------------------

describe('secrets never logged', () => {
  it('does not expose the OpenRouter key in any returned field or thrown error', async () => {
    const FAKE_KEY = 'sk-or-v1-SUPER_SECRET_KEY_DO_NOT_LOG';

    // Capture any console.log / console.error calls during the run
    const logged: string[] = [];
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };

    try {
      const deps: UsageDeps = {
        runCcusage: () => makeCcusageJson([
          {
            projectPath: DIR,
            models: [
              {
                model: 'z-ai/glm-5.2',
                input_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 50,
                cost_usd: 0.001,
              },
            ],
          },
        ]),
        fetchOpenRouterCredits: async () => {
          // Simulate reading the key and making a call — key must NOT leak
          void FAKE_KEY; // reference it so the closure captures it
          return { total_credits: 5.0, total_usage: 0.001 };
        },
      };

      const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

      // Key must not appear in the result's JSON serialization
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(FAKE_KEY);

      // Key must not appear in any console output
      const allOutput = logged.join('\n');
      expect(allOutput).not.toContain(FAKE_KEY);
    } finally {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// ccusage version pinning
// ---------------------------------------------------------------------------

describe('ccusage version', () => {
  it('passes the pinned version (or opts.ccusageVersion) to runCcusage', async () => {
    const calledWith: Array<{ tool: string; version: string }> = [];

    const deps: UsageDeps = {
      runCcusage: (tool, version) => {
        calledWith.push({ tool, version });
        return makeCcusageJson([]);
      },
      fetchOpenRouterCredits: async () => null,
    };

    await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

    // Both claude and codex should be called
    expect(calledWith.some(c => c.tool === 'claude')).toBe(true);
    expect(calledWith.some(c => c.tool === 'codex')).toBe(true);

    // All calls should use the same non-empty version string
    for (const call of calledWith) {
      expect(call.version).toBeTruthy();
      expect(call.version).not.toBe('latest');
      expect(call.version).not.toContain('@latest');
    }
  });

  it('uses opts.ccusageVersion when provided', async () => {
    const calledVersions: string[] = [];

    const deps: UsageDeps = {
      runCcusage: (_tool, version) => {
        calledVersions.push(version);
        return makeCcusageJson([]);
      },
      fetchOpenRouterCredits: async () => null,
    };

    await computeValueUsage(
      { dir: DIR, since: SINCE, until: UNTIL, ccusageVersion: '12.0.0' },
      deps,
    );

    expect(calledVersions.every(v => v === '12.0.0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agents field
// ---------------------------------------------------------------------------

describe('agents field', () => {
  it('includes "claude" when claude data present, "codex" when codex data present', async () => {
    const claudeJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [{ model: 'claude-sonnet-4-5', input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50, cost_usd: 0.01 }],
      },
    ]);
    const codexJson = makeCcusageJson([
      {
        projectPath: DIR,
        models: [{ model: 'claude-sonnet-4-5', input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 25, cost_usd: 0 }],
      },
    ]);

    const deps: UsageDeps = {
      runCcusage: (tool) => (tool === 'claude' ? claudeJson : codexJson),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.agents).toContain('claude');
    expect(result.data.agents).toContain('codex');
  });
});
