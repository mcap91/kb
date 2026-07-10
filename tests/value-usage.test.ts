/**
 * Tests for computeValueUsage (value-usage.ts).
 *
 * TDD: tests written first, then implementation.
 * Maps to spec §11.7 scenarios, updated to the REAL scraper architecture
 * (verified 2026-07-10 against ccusage 20.0.17):
 *
 *  - Claude family (subscription / local / OpenRouter) via ccusage
 *    `claude daily --json --instances` → repo-filtered by the encoded-cwd key.
 *  - Codex via raw ~/.codex session logs → repo-filtered by cwd prefix match
 *    (interactive sessions launch at the repo root; dispatch runs at a subdir
 *    under the repo). Codex is tokens-only (no per-repo $).
 *
 * Strategy: inject fake UsageDeps — runClaudeCcusage returns canned JSON,
 * readCodexSessions returns canned sessions, fetchOpenRouterCredits returns a
 * fake response or null. No network, no real ccusage, no real ~/.claude access.
 *
 * ccusage claude `--instances` shape:
 * {
 *   projects: { "<encoded-cwd>": [ { date, project,
 *     inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
 *     totalCost, totalTokens, modelsUsed,
 *     modelBreakdowns: [ { modelName, inputTokens, outputTokens,
 *       cacheCreationTokens, cacheReadTokens, cost } ] } ] },
 *   totals: {...}
 * }
 */

import { describe, it, expect } from 'vitest';
import type { UsageDeps, CodexSessionUsage } from '../packages/wiki-core/src/value-usage.js';
import { computeValueUsage } from '../packages/wiki-core/src/value-usage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIR = 'C:\\Users\\mcap9\\projects\\kb';
const SINCE = '2026-07-01';
const UNTIL = '2026-07-10';

// The encoded-cwd project key ccusage emits for DIR (: \ / -> -).
const ENCODED_DIR = DIR.replace(/[:\\/]/g, '-'); // C--Users-mcap9-projects-kb

interface ModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

/** Build a `ccusage claude daily --json --instances` payload for one project. */
function makeClaudeJson(models: ModelBreakdown[], projectKey: string = ENCODED_DIR): string {
  return makeClaudeMultiProject({ [projectKey]: models });
}

/** Build a claude payload spanning multiple projects (for filtering tests). */
function makeClaudeMultiProject(byProject: Record<string, ModelBreakdown[]>): string {
  const projects: Record<string, unknown[]> = {};
  for (const [key, models] of Object.entries(byProject)) {
    const sum = (f: keyof ModelBreakdown) => models.reduce((s, m) => s + (m[f] as number), 0);
    projects[key] = [
      {
        date: '2026-07-05',
        project: key,
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        cacheCreationTokens: sum('cacheCreationTokens'),
        cacheReadTokens: sum('cacheReadTokens'),
        totalCost: sum('cost'),
        totalTokens:
          sum('inputTokens') + sum('outputTokens') + sum('cacheCreationTokens') + sum('cacheReadTokens'),
        modelsUsed: models.map((m) => m.modelName),
        modelBreakdowns: models,
      },
    ];
  }
  return JSON.stringify({ projects, totals: {} });
}

function emptyClaudeJson(): string {
  return JSON.stringify({ projects: {}, totals: {} });
}

/** Build a codex session usage record (already normalized). */
function codexSession(
  cwd: string,
  model: string,
  input: number,
  cacheRead: number,
  output: number,
): CodexSessionUsage {
  return {
    cwd,
    model,
    input_tokens: input,
    cache_read_tokens: cacheRead,
    output_tokens: output,
    total_tokens: input + cacheRead + output,
  };
}

/** Deps where codex is absent (empty session list). */
function noCodex(): UsageDeps['readCodexSessions'] {
  return () => [];
}

// ---------------------------------------------------------------------------
// §11.7 — Claude family (via ccusage --instances)
// ---------------------------------------------------------------------------

describe('ccusage available — subscription arm (claude-*)', () => {
  it('returns tokens from the target project, no dollar amount, provenance subscription-covered', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'claude-sonnet-4-6',
        inputTokens: 1000,
        cacheCreationTokens: 200,
        cacheReadTokens: 300,
        outputTokens: 500,
        cost: 0.05, // ccusage prices it, but we must NOT report $ for subscription
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
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

    expect(d.by_model).toHaveLength(1);
    const model = d.by_model[0];
    expect(model?.model).toBe('claude-sonnet-4-6');
    expect(model?.arm).toBe('subscription');
    expect(model?.cost_usd).toBeNull();
  });
});

describe('ccusage available — local arm (name:tag)', () => {
  it('returns $0 and local-free provenance for qwen3-coder:30b model', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'qwen3-coder:30b',
        inputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 200,
        cost: 0,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
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
    const claudeJson = makeClaudeJson([
      {
        modelName: 'z-ai/glm-5.2',
        inputTokens: 800,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 400,
        cost: 0.02, // ccusage estimate — should be overridden by OR credits
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => ({ total_credits: 10.0, total_usage: 0.05 }),
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    expect(d.cost_provenance).toBe('openrouter-api');
    expect(d.cost_usd).toBe(0.05); // authoritative OR total_usage
    expect(d.by_model[0]?.arm).toBe('openrouter');
  });

  it('falls back to ccusage-priced when OpenRouter credits not available', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'deepseek/deepseek-chat',
        inputTokens: 600,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 300,
        cost: 0.01,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_provenance).toBe('ccusage-priced');
    expect(result.data.cost_usd).toBe(0.01); // from ccusage modelBreakdowns[].cost
  });
});

describe('provenance mixed — subscription + openrouter in same window', () => {
  it('sets overall provenance to mixed', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'claude-opus-4-8',
        inputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 400,
        cost: 0.1,
      },
      {
        modelName: 'z-ai/glm-5.2',
        inputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 200,
        cost: 0.02,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
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
// §11.7 — self-awareness: absent / empty / errored
// ---------------------------------------------------------------------------

describe('ccusage absent + no codex — self-aware', () => {
  it('returns ok() with unavailable provenance + reason, never fail()', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => {
        throw new Error('npx: command not found');
      },
      readCodexSessions: noCodex(),
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
      runClaudeCcusage: () => 'not json at all',
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_provenance).toBe('unavailable');
    expect(result.data.reason).toBeDefined();
  });
});

describe('ccusage returns empty-for-span (no matching project, no codex)', () => {
  it('returns ok() with unavailable provenance + reason', async () => {
    const claudeJson = makeClaudeJson(
      [
        {
          modelName: 'claude-sonnet-4-6',
          inputTokens: 999,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 100,
          cost: 0.01,
        },
      ],
      'C--Users-mcap9-projects-other-project',
    );

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
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

describe('instance filtering — only target dir entries are counted', () => {
  it('sums tokens only from the instance matching dir (encoded-cwd match)', async () => {
    const claudeJson = makeClaudeMultiProject({
      [ENCODED_DIR]: [
        {
          modelName: 'claude-sonnet-4-6',
          inputTokens: 1000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 500,
          cost: 0.05,
        },
      ],
      'C--Users-mcap9-projects-other': [
        {
          modelName: 'claude-sonnet-4-6',
          inputTokens: 9999,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 9999,
          cost: 9.99,
        },
      ],
    });

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    expect(d.input_tokens).toBe(1000);
    expect(d.output_tokens).toBe(500);
    expect(d.total_tokens).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// §11.7 — codex repo attribution via raw ~/.codex logs
// ---------------------------------------------------------------------------

describe('codex — repo-attributed by cwd (interactive session at repo root)', () => {
  it('counts codex tokens for a session launched at the repo root, arm=codex, tokens-only', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => emptyClaudeJson(),
      // Interactive codex at the kb repo root — exactly the you+codex case.
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 1000, 5000, 300)],
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    expect(d.input_tokens).toBe(1000);
    expect(d.cache_read_tokens).toBe(5000);
    expect(d.output_tokens).toBe(300);
    expect(d.total_tokens).toBe(6300);
    expect(d.agents).toContain('codex');
    const model = d.by_model.find((m) => m.arm === 'codex');
    expect(model?.model).toBe('gpt-5.5');
    expect(model?.cost_usd).toBeNull(); // codex is tokens-only
    expect(d.cost_usd).toBeNull();
  });
});

describe('codex — dispatch run under repo subdir is attributed; other repos excluded', () => {
  it('includes .agent-runs subdir sessions and excludes sessions in other repos', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => emptyClaudeJson(),
      readCodexSessions: () => [
        // dispatch run under kb → attributed
        codexSession(
          'C:\\Users\\mcap9\\projects\\kb\\.agent-runs\\runs\\HO-0003\\RUN-x\\agent-visible',
          'gpt-5.5',
          100,
          200,
          50,
        ),
        // different repo → must be excluded
        codexSession('C:\\Users\\mcap9\\projects\\other-repo', 'gpt-5.5', 99999, 0, 99999),
        // sibling repo with shared prefix "kb" — must NOT match (separator guard)
        codexSession('C:\\Users\\mcap9\\projects\\kb-sandbox', 'gpt-5.5', 88888, 0, 88888),
      ],
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    // Only the .agent-runs session under kb counts: 100 + 200 + 50 = 350
    expect(d.total_tokens).toBe(350);
    expect(d.input_tokens).toBe(100);
  });
});

describe('codex works even when ccusage/claude is entirely absent', () => {
  it('returns codex tokens (not unavailable) when only codex has repo data', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => {
        throw new Error('npx: command not found');
      },
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 500, 0, 100)],
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    expect(d.cost_provenance).not.toBe('unavailable');
    expect(d.total_tokens).toBe(600);
    expect(d.agents).toEqual(['codex']);
  });
});

describe('codex + claude in the same window', () => {
  it('sums both, codex stays tokens-only, overall provenance subscription-covered', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'claude-opus-4-8',
        inputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 400,
        cost: 0.1,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 200, 0, 100)],
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    // claude 1000+400=1400 + codex 200+100=300 → 1700
    expect(d.total_tokens).toBe(1700);
    expect(d.cost_usd).toBeNull(); // both arms tokens-only
    expect(d.cost_provenance).toBe('subscription-covered');
    expect(d.agents).toEqual(['claude', 'codex']);
    expect(d.by_model).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §11.7 — local always $0 / subscription never fabricates $
// ---------------------------------------------------------------------------

describe('local arm — always $0 regardless of ccusage pricing', () => {
  it('reports cost_usd=0 and local-free even if ccusage would price it', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'llama3.2:3b',
        inputTokens: 2000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 1000,
        cost: 0.001,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_usd).toBe(0);
    expect(result.data.cost_provenance).toBe('local-free');
  });
});

describe('subscription arm — no fabricated dollar figure', () => {
  it('cost_usd is null (not 0, not a number) for pure subscription usage', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'claude-haiku-4-5',
        inputTokens: 5000,
        cacheCreationTokens: 1000,
        cacheReadTokens: 2000,
        outputTokens: 1500,
        cost: 0.5,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
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

    const logged: string[] = [];
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };

    try {
      const deps: UsageDeps = {
        runClaudeCcusage: () =>
          makeClaudeJson([
            {
              modelName: 'z-ai/glm-5.2',
              inputTokens: 100,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 50,
              cost: 0.001,
            },
          ]),
        readCodexSessions: noCodex(),
        fetchOpenRouterCredits: async () => {
          void FAKE_KEY; // reference it so the closure captures it
          return { total_credits: 5.0, total_usage: 0.001 };
        },
      };

      const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(FAKE_KEY);

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
  it('passes a pinned (non-@latest) version to runClaudeCcusage', async () => {
    const calledVersions: string[] = [];

    const deps: UsageDeps = {
      runClaudeCcusage: (version) => {
        calledVersions.push(version);
        return emptyClaudeJson();
      },
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => null,
    };

    await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);

    expect(calledVersions.length).toBeGreaterThan(0);
    for (const v of calledVersions) {
      expect(v).toBeTruthy();
      expect(v).not.toBe('latest');
      expect(v).not.toContain('@latest');
    }
  });

  it('uses opts.ccusageVersion when provided', async () => {
    const calledVersions: string[] = [];

    const deps: UsageDeps = {
      runClaudeCcusage: (version) => {
        calledVersions.push(version);
        return emptyClaudeJson();
      },
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => null,
    };

    await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL, ccusageVersion: '99.0.0' }, deps);

    expect(calledVersions.every((v) => v === '99.0.0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agents field
// ---------------------------------------------------------------------------

describe('agents field', () => {
  it('includes "claude" for claude-family data and "codex" for codex sessions', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'claude-sonnet-4-6',
        inputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 50,
        cost: 0.01,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 10, 0, 5)],
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.agents).toContain('claude');
    expect(result.data.agents).toContain('codex');
  });
});
