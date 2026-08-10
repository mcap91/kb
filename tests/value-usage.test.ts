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

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { UsageDeps, CodexSessionUsage } from '../packages/wiki-core/src/value-usage.js';
import { computeValueUsage, defaultListWorktreeRoots } from '../packages/wiki-core/src/value-usage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Host-native synthetic fixture root. The impl calls path.resolve(opts.dir),
// which is host-OS dependent — a hardcoded Windows path resolves wrong on Linux
// (WK-0043). Derive DIR per platform so it is already absolute for the host
// running the suite, making path.resolve a no-op and the fixtures symmetric on
// both OSes. The synthetic paths need not physically exist.
const IS_WIN = process.platform === 'win32';
const SEP = IS_WIN ? '\\' : '/';
const HOME_ROOT = IS_WIN ? 'C:\\Users\\test\\projects' : '/home/test/projects';
const DIR = `${HOME_ROOT}${SEP}kb`;
const SINCE = '2026-07-01';
const UNTIL = '2026-07-10';

// The encoded-cwd project key ccusage emits for DIR (: \ / -> -).
// e.g. win32: C--Users-test-projects-kb ; linux: -home-test-projects-kb
const ENCODED_DIR = DIR.replace(/[:\\/]/g, '-');

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
      (HOME_ROOT + SEP + 'other-project').replace(/[:\\/]/g, '-'),
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
      [(HOME_ROOT + SEP + 'other').replace(/[:\\/]/g, '-')]: [
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
          DIR + SEP + '.agent-runs' + SEP + 'runs' + SEP + 'HO-0003' + SEP + 'RUN-x' + SEP + 'agent-visible',
          'gpt-5.5',
          100,
          200,
          50,
        ),
        // different repo → must be excluded
        codexSession(HOME_ROOT + SEP + 'other-repo', 'gpt-5.5', 99999, 0, 99999),
        // sibling repo with shared prefix "kb" — must NOT match (separator guard)
        codexSession(HOME_ROOT + SEP + 'kb-sandbox', 'gpt-5.5', 88888, 0, 88888),
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
// Dual cost fields — cost_usd_est (ccusage at-API-rates estimate, every arm)
//
// cost_usd stays the real/marginal out-of-pocket figure (subscription/codex →
// null, local → 0, OR → authoritative). cost_usd_est is the ccusage LiteLLM
// "what it would've metered at API rates" figure, populated for ALL arms:
// claude family from modelBreakdowns[].cost; codex by joining repo-matched raw
// sessions to `ccusage codex session --json` on sessionId.
// ---------------------------------------------------------------------------

/** Codex session usage with the rollout session UUID (join key). */
function codexSessionWithId(
  id: string,
  cwd: string,
  model: string,
  input: number,
  cacheRead: number,
  output: number,
): CodexSessionUsage {
  return { ...codexSession(cwd, model, input, cacheRead, output), session_id: id };
}

/**
 * Build a `ccusage codex session --json` payload (the $ lookup table).
 * REAL v20 shape (verified 2026-07-10): `sessionId` is the relative session
 * path WITHOUT extension — `<Y>/<M>/<D>/rollout-<ISO>-<uuid>` — not the bare
 * UUID. The join must therefore normalize on the trailing UUID.
 */
function codexSessionsJson(entries: { sessionId: string; costUSD: number }[]): string {
  return JSON.stringify({
    sessions: entries.map((e) => ({
      sessionId: `2026/07/10/rollout-2026-07-10T00-00-00-${e.sessionId}`,
      sessionFile: `rollout-2026-07-10T00-00-00-${e.sessionId}`,
      directory: '2026/07/10', // date folder, NOT cwd — useless for repo scope
      costUSD: e.costUSD,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      lastActivity: '2026-07-10T00:00:00Z',
      models: {},
    })),
    totals: {},
  });
}

describe('cost_usd_est — subscription arm carries the ccusage estimate', () => {
  it('populates per-model and total cost_usd_est while cost_usd stays null', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'claude-opus-4-8',
        inputTokens: 1000,
        cacheCreationTokens: 200,
        cacheReadTokens: 300,
        outputTokens: 500,
        cost: 46.36,
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
    expect(d.cost_usd).toBeNull(); // marginal out-of-pocket: still null
    expect(d.cost_usd_est).toBeCloseTo(46.36, 6); // at-API-rates estimate kept
    expect(d.cost_provenance).toBe('subscription-covered');
    expect(d.by_model[0]?.cost_usd).toBeNull();
    expect(d.by_model[0]?.cost_usd_est).toBeCloseTo(46.36, 6);
  });
});

describe('cost_usd_est — local arm', () => {
  it('carries the ccusage estimate while cost_usd stays 0', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'qwen3-coder:30b',
        inputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 200,
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
    expect(result.data.cost_usd_est).toBeCloseTo(0.001, 6);
    expect(result.data.by_model[0]?.cost_usd_est).toBeCloseTo(0.001, 6);
  });
});

describe('cost_usd_est — openrouter arm keeps the estimate beside the authoritative $', () => {
  it('cost_usd from OR credits, cost_usd_est from ccusage pricing', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'z-ai/glm-5.2',
        inputTokens: 800,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 400,
        cost: 0.02,
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

    expect(result.data.cost_usd).toBe(0.05); // authoritative
    expect(result.data.cost_usd_est).toBeCloseTo(0.02, 6); // ccusage estimate preserved
    expect(result.data.by_model[0]?.cost_usd_est).toBeCloseTo(0.02, 6);
  });
});

describe('cost_usd_est — codex priced via sessionId join', () => {
  it('joins repo-matched raw sessions to ccusage codex session costUSD', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => emptyClaudeJson(),
      readCodexSessions: () => [
        codexSessionWithId('019f4d52-ebe1-7381-b007-7445c17cfc72', DIR, 'gpt-5.5', 1000, 5000, 300),
      ],
      runCodexCcusageSessions: () =>
        codexSessionsJson([
          { sessionId: '019f4d52-ebe1-7381-b007-7445c17cfc72', costUSD: 1.921991 },
          { sessionId: 'ffffffff-0000-0000-0000-000000000000', costUSD: 99.0 }, // other repo — not ours
        ]),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const d = result.data;
    const codexModel = d.by_model.find((m) => m.arm === 'codex');
    expect(codexModel?.cost_usd).toBeNull(); // marginal: still tokens-only
    expect(codexModel?.cost_usd_est).toBeCloseTo(1.921991, 6); // only OUR session's $
    expect(d.cost_usd).toBeNull();
    expect(d.cost_usd_est).toBeCloseTo(1.921991, 6);
  });

  it('sums priced sessions per model and ignores unpriced ones (partial, downward-biased)', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => emptyClaudeJson(),
      readCodexSessions: () => [
        codexSessionWithId('aaaaaaaa-1111-1111-1111-111111111111', DIR, 'gpt-5.5', 100, 0, 50),
        codexSessionWithId('bbbbbbbb-2222-2222-2222-222222222222', DIR, 'gpt-5.5', 200, 0, 80),
        codexSession(DIR, 'gpt-5.5', 300, 0, 90), // no session_id → can't join
      ],
      runCodexCcusageSessions: () =>
        codexSessionsJson([
          { sessionId: 'aaaaaaaa-1111-1111-1111-111111111111', costUSD: 0.5 },
          // bbbbbbbb missing from ccusage list → unpriced
        ]),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const codexModel = result.data.by_model.find((m) => m.arm === 'codex');
    expect(codexModel?.cost_usd_est).toBeCloseTo(0.5, 6);
    // tokens still counted for ALL sessions regardless of pricing
    expect(result.data.total_tokens).toBe(150 + 280 + 390);
  });
});

describe('cost_usd_est — codex join unavailable degrades to null, never errors', () => {
  it('est is null when the codex ccusage pricing call throws', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => emptyClaudeJson(),
      readCodexSessions: () => [
        codexSessionWithId('019f4d52-ebe1-7381-b007-7445c17cfc72', DIR, 'gpt-5.5', 1000, 0, 300),
      ],
      runCodexCcusageSessions: () => {
        throw new Error('npx: command not found');
      },
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const codexModel = result.data.by_model.find((m) => m.arm === 'codex');
    expect(codexModel?.cost_usd_est).toBeNull();
    expect(result.data.cost_usd_est).toBeNull(); // nothing priced anywhere
    expect(result.data.total_tokens).toBe(1300); // tokens unaffected
  });

  it('est is null when the pricing dep is not provided at all', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => emptyClaudeJson(),
      readCodexSessions: () => [codexSessionWithId('cccccccc-3333-3333-3333-333333333333', DIR, 'gpt-5.5', 500, 0, 100)],
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.by_model.find((m) => m.arm === 'codex')?.cost_usd_est).toBeNull();
    expect(result.data.cost_usd_est).toBeNull();
  });
});

describe('cost_usd_est — mixed claude + codex total', () => {
  it('sums claude and joined codex estimates into the total', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'claude-opus-4-8',
        inputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 400,
        cost: 86.57,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: () => [
        codexSessionWithId('019f4d52-ebe1-7381-b007-7445c17cfc72', DIR, 'gpt-5.5', 200, 0, 100),
      ],
      runCodexCcusageSessions: () =>
        codexSessionsJson([{ sessionId: '019f4d52-ebe1-7381-b007-7445c17cfc72', costUSD: 1.92 }]),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_usd).toBeNull(); // all subscription-covered
    expect(result.data.cost_usd_est).toBeCloseTo(88.49, 6);
  });

  it('total est sums numeric per-model ests even when codex is unpriced', async () => {
    const claudeJson = makeClaudeJson([
      {
        modelName: 'claude-sonnet-4-6',
        inputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 50,
        cost: 0.25,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 10, 0, 5)], // no id → unpriced
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_usd_est).toBeCloseTo(0.25, 6);
  });
});

describe('cost_usd_est — unavailable metrics carry null', () => {
  it('unavailable result includes cost_usd_est null', async () => {
    const deps: UsageDeps = {
      runClaudeCcusage: () => {
        throw new Error('npx: command not found');
      },
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.cost_provenance).toBe('unavailable');
    expect(result.data.cost_usd_est).toBeNull();
  });
});

describe('cost_usd_est — codex pricing call receives the pinned version and window', () => {
  it('passes version/since/until through to runCodexCcusageSessions', async () => {
    const calls: Array<{ version: string; since: string; until: string }> = [];

    const deps: UsageDeps = {
      runClaudeCcusage: () => emptyClaudeJson(),
      readCodexSessions: () => [
        codexSessionWithId('dddddddd-4444-4444-4444-444444444444', DIR, 'gpt-5.5', 10, 0, 5),
      ],
      runCodexCcusageSessions: (version, since, until) => {
        calls.push({ version, since, until });
        return codexSessionsJson([]);
      },
      fetchOpenRouterCredits: async () => null,
    };

    await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL, ccusageVersion: '99.0.0' }, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ version: '99.0.0', since: SINCE, until: UNTIL });
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

// ---------------------------------------------------------------------------
// WK-0036 — Bedrock/Vertex enterprise ids must never be misclassified as local
// ---------------------------------------------------------------------------

describe('WK-0036: Bedrock inference-profile id without config — classifies unknown, never local/$0', () => {
  it(
    // WHY (WK-0036): Bedrock is PAYG; silent $0 undercounts real spend.
    // A Bedrock id like "us.anthropic.claude-sonnet-4-6-v1:0" contains ":" so the
    // old heuristic classified it as local → cost_usd=0.  After the fix it must
    // fall through to unknown → ccusage-priced (a real number, never $0).
    'us.anthropic.claude-sonnet-4-6-v1:0 → unknown arm, ccusage-priced provenance, cost_usd is the ccusage figure, NOT $0',
    async () => {
      const bedrockModel = 'us.anthropic.claude-sonnet-4-6-v1:0';
      const claudeJson = makeClaudeJson([
        {
          modelName: bedrockModel,
          inputTokens: 1000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 400,
          cost: 0.042, // ccusage prices it — must flow through as real $
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
      const model = d.by_model.find((m) => m.model === bedrockModel);
      expect(model).toBeDefined();

      // Must NOT be local — that would zero out a real PAYG cost
      expect(model?.arm).not.toBe('local');
      // Must NOT be $0 — Bedrock charges are real
      expect(model?.cost_usd).not.toBe(0);
      // Must price via ccusage (unknown arm path)
      expect(model?.arm).toBe('unknown');
      expect(d.cost_provenance).toBe('ccusage-priced');
      expect(d.cost_usd).toBeCloseTo(0.042, 6);
    },
  );

  it('eu.anthropic.claude-opus-4-0-v1:0 (EU region profile) → unknown, never local', async () => {
    // WHY (WK-0036): EU-region Bedrock profiles follow the same pattern.
    const bedrockEu = 'eu.anthropic.claude-opus-4-0-v1:0';
    const claudeJson = makeClaudeJson([
      {
        modelName: bedrockEu,
        inputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 100,
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

    const model = result.data.by_model.find((m) => m.model === bedrockEu);
    expect(model?.arm).not.toBe('local');
    expect(model?.arm).toBe('unknown');
    expect(model?.cost_usd).toBeCloseTo(0.01, 6);
  });
});

describe('WK-0036: model_patterns config overrides heuristics', () => {
  it(
    // WHY (WK-0036): gateways rewrite model strings arbitrarily; config must
    // override heuristics. A pattern matching "us.anthropic" with arm "openrouter"
    // must win over the default unknown-arm heuristic.
    'config pattern us.anthropic → arm openrouter wins; same id without config → unknown',
    async () => {
      const bedrockModel = 'us.anthropic.claude-sonnet-4-6-v1:0';
      const claudeJson = makeClaudeJson([
        {
          modelName: bedrockModel,
          inputTokens: 500,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 200,
          cost: 0.015,
        },
      ]);

      // WITH config: pattern routes to openrouter
      const depsWithConfig: UsageDeps = {
        runClaudeCcusage: () => claudeJson,
        readCodexSessions: noCodex(),
        fetchOpenRouterCredits: async () => null,
      };
      const resultWithConfig = await computeValueUsage(
        {
          dir: DIR,
          since: SINCE,
          until: UNTIL,
          config: { model_patterns: [{ pattern: 'us.anthropic', arm: 'openrouter' }] },
        },
        depsWithConfig,
      );
      expect(resultWithConfig.ok).toBe(true);
      if (!resultWithConfig.ok) return;
      const withConfigModel = resultWithConfig.data.by_model.find((m) => m.model === bedrockModel);
      // Pattern wins → openrouter arm
      expect(withConfigModel?.arm).toBe('openrouter');

      // WITHOUT config: falls back to unknown
      const depsNoConfig: UsageDeps = {
        runClaudeCcusage: () => claudeJson,
        readCodexSessions: noCodex(),
        fetchOpenRouterCredits: async () => null,
      };
      const resultNoConfig = await computeValueUsage(
        { dir: DIR, since: SINCE, until: UNTIL },
        depsNoConfig,
      );
      expect(resultNoConfig.ok).toBe(true);
      if (!resultNoConfig.ok) return;
      const noConfigModel = resultNoConfig.data.by_model.find((m) => m.model === bedrockModel);
      expect(noConfigModel?.arm).toBe('unknown');
    },
  );

  it('first matching pattern wins; non-matching patterns are skipped', async () => {
    // WHY (WK-0036): first-match semantics must be stable.
    const model = 'us.anthropic.claude-haiku-3-v1:0';
    const claudeJson = makeClaudeJson([
      {
        modelName: model,
        inputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 50,
        cost: 0.003,
      },
    ]);

    const deps: UsageDeps = {
      runClaudeCcusage: () => claudeJson,
      readCodexSessions: noCodex(),
      fetchOpenRouterCredits: async () => null,
    };

    const result = await computeValueUsage(
      {
        dir: DIR,
        since: SINCE,
        until: UNTIL,
        config: {
          model_patterns: [
            { pattern: 'no-match-xyz', arm: 'local' }, // does not match
            { pattern: 'us.anthropic', arm: 'subscription' }, // matches first
            { pattern: 'anthropic', arm: 'openrouter' }, // would match but is after
          ],
        },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const m = result.data.by_model.find((bm) => bm.model === model);
    expect(m?.arm).toBe('subscription'); // first match wins
  });
});

// ---------------------------------------------------------------------------
// Worktree-agnostic attribution (listWorktreeRoots)
// ---------------------------------------------------------------------------

/**
 * Encode a cwd path the way Claude Code does (: \ / → -) so tests can build
 * project keys for worktree paths without importing the internal helper.
 */
function encodeWorktreePath(p: string): string {
  return p.replace(/[:\\/]/g, '-');
}

const WORKTREE_PATH = HOME_ROOT + SEP + 'kb-wt' + SEP + 'main';
const WORKTREE_ENCODED = encodeWorktreePath(WORKTREE_PATH);

describe('worktree-agnostic — Claude inclusion via listWorktreeRoots', () => {
  it(
    // WHY: sessions run in a git worktree of the repo log usage under the
    // worktree path, not the main checkout path. Without listWorktreeRoots
    // those tokens are silently dropped. This test confirms they ARE counted.
    'ccusage project keyed by a worktree-encoded path is attributed to the repo when listWorktreeRoots returns that path',
    async () => {
      const claudeJson = makeClaudeMultiProject({
        [WORKTREE_ENCODED]: [
          {
            modelName: 'claude-sonnet-4-6',
            inputTokens: 2000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 800,
            cost: 0.1,
          },
        ],
      });

      const deps: UsageDeps = {
        runClaudeCcusage: () => claudeJson,
        readCodexSessions: noCodex(),
        fetchOpenRouterCredits: async () => null,
        listWorktreeRoots: () => [WORKTREE_PATH],
      };

      const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const d = result.data;
      // Worktree project must be counted, not dropped
      expect(d.input_tokens).toBe(2000);
      expect(d.output_tokens).toBe(800);
      expect(d.total_tokens).toBe(2800);
      expect(d.cost_provenance).toBe('subscription-covered');
    },
  );
});

describe('worktree-agnostic — Codex inclusion via listWorktreeRoots', () => {
  it(
    // WHY: a codex session launched inside a worktree (or its subdirectory)
    // has a cwd under the worktree root. The isUnderDir check against the main
    // repo dir alone misses it. This test confirms worktree-cwd sessions ARE
    // attributed, and unrelated paths are still excluded.
    'codex session under a worktree root is attributed; unrelated cwd is excluded',
    async () => {
      const wtSubdir = WORKTREE_PATH + SEP + 'src' + SEP + 'subdir';
      const unrelatedCwd = HOME_ROOT + SEP + 'totally-other';

      const deps: UsageDeps = {
        runClaudeCcusage: () => emptyClaudeJson(),
        readCodexSessions: () => [
          codexSession(wtSubdir, 'gpt-5.5', 500, 0, 200),   // under worktree → count
          codexSession(unrelatedCwd, 'gpt-5.5', 9999, 0, 9999), // unrelated → exclude
        ],
        fetchOpenRouterCredits: async () => null,
        listWorktreeRoots: () => [WORKTREE_PATH],
      };

      const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const d = result.data;
      // Only the worktree session (500 + 200 = 700 tokens)
      expect(d.input_tokens).toBe(500);
      expect(d.output_tokens).toBe(200);
      expect(d.total_tokens).toBe(700);
    },
  );
});

describe('worktree-agnostic — regression: partial deps without listWorktreeRoots', () => {
  it(
    // WHY: callers providing a custom deps object without listWorktreeRoots must
    // retain today's behavior — worktree-keyed projects are NOT counted. The
    // optional member must degrade to [] (no extra roots) when absent from a
    // CALLER-PROVIDED deps object, so existing hermetic tests are unaffected.
    'worktree-keyed project is NOT counted when deps has no listWorktreeRoots (existing hermetic behavior preserved)',
    async () => {
      const claudeJson = makeClaudeMultiProject({
        [WORKTREE_ENCODED]: [
          {
            modelName: 'claude-sonnet-4-6',
            inputTokens: 5000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 2000,
            cost: 0.3,
          },
        ],
      });

      // deps object WITHOUT listWorktreeRoots → no extra roots → worktree project excluded
      const deps: UsageDeps = {
        runClaudeCcusage: () => claudeJson,
        readCodexSessions: noCodex(),
        fetchOpenRouterCredits: async () => null,
      };

      const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Nothing matched — unavailable
      expect(result.data.cost_provenance).toBe('unavailable');
      expect(result.data.total_tokens).toBe(0);
    },
  );
});

describe('worktree-agnostic — no double-count when listWorktreeRoots echoes main dir', () => {
  it(
    // WHY: `git worktree list --porcelain` always includes the main checkout as
    // the first entry. If listWorktreeRoots returns the main dir itself (or
    // duplicates), the same project should be counted exactly once, not twice.
    'main dir returned by listWorktreeRoots + duplicate entries → each project counted once',
    async () => {
      // A project keyed by the main dir (already matched by direct check)
      const claudeJson = makeClaudeMultiProject({
        [ENCODED_DIR]: [
          {
            modelName: 'claude-sonnet-4-6',
            inputTokens: 1000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 400,
            cost: 0.05,
          },
        ],
      });

      const deps: UsageDeps = {
        runClaudeCcusage: () => claudeJson,
        readCodexSessions: noCodex(),
        fetchOpenRouterCredits: async () => null,
        // Returns main dir + a duplicate — typical git worktree list output
        listWorktreeRoots: () => [DIR, DIR, WORKTREE_PATH],
      };

      const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const d = result.data;
      // Exactly 1 model row (no duplicates from multiple root matches)
      expect(d.by_model).toHaveLength(1);
      // Tokens counted once only
      expect(d.input_tokens).toBe(1000);
      expect(d.output_tokens).toBe(400);
      expect(d.total_tokens).toBe(1400);
    },
  );
});

describe('defaultListWorktreeRoots — integration with real git worktree', () => {
  let tmpDir: string;
  let wtDir: string;

  afterEach(() => {
    // Remove worktree then clean up tmp dirs
    if (wtDir && fs.existsSync(wtDir)) {
      try {
        execSync(`git -C "${tmpDir}" worktree remove --force "${wtDir}"`, { stdio: 'pipe' });
      } catch {
        // Best-effort
      }
    }
    for (const d of [tmpDir, wtDir]) {
      if (d) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });

  it(
    // WHY: defaultListWorktreeRoots must return EVERY worktree root — main
    // checkout AND linked worktrees, no positional assumptions (dir may itself
    // be a linked worktree). Dedup against targetDir is the caller's job,
    // encoded in the no-double-count test above. Real git repo + worktree.
    'returns both the main checkout and the linked worktree path',
    async () => {
      // Create a real git repo
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-wt-test-'));
      execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
      // Need a commit before adding a worktree
      fs.writeFileSync(path.join(tmpDir, 'README'), 'init', 'utf-8');
      execSync('git add README', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

      // Create a linked worktree on a new branch
      wtDir = path.join(os.tmpdir(), `kb-wt-branch-${Date.now()}`);
      execSync(`git worktree add "${wtDir}" -b wt-test-branch`, { cwd: tmpDir, stdio: 'pipe' });

      const roots = defaultListWorktreeRoots(tmpDir);
      const normalizedRoots = roots.map((r) => path.resolve(r).toLowerCase());

      // Linked worktree AND main checkout both present (caller dedupes)
      expect(normalizedRoots).toContain(path.resolve(wtDir).toLowerCase());
      expect(normalizedRoots).toContain(path.resolve(tmpDir).toLowerCase());
    },
  );

  it(
    // WHY: when git is unavailable or the dir is not a git repo, the function
    // must return [] and never throw — ensuring the whole scrape degrades
    // gracefully to main-dir-only attribution.
    'returns [] and never throws when dir is not a git repo',
    () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-nogit-'));
      tmpDir = nonGitDir; // cleaned up in afterEach
      expect(() => {
        const result = defaultListWorktreeRoots(nonGitDir);
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(0);
      }).not.toThrow();
    },
  );
});

describe('WK-0036: contract preserved — pre-existing arm heuristics unchanged', () => {
  // Plain-heuristic contract (claude-* → subscription, name:tag → local) is covered by the
  // dedicated subscription-arm and local-arm describes above; only the slash-namespaced heuristic
  // is guarded here to avoid duplicating those.
  it('slash-namespaced → openrouter unchanged', async () => {
    // WHY (WK-0036): openrouter heuristic must still fire.
    const claudeJson = makeClaudeJson([
      {
        modelName: 'z-ai/glm-5.2',
        inputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 100,
        cost: 0.002,
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
    expect(result.data.by_model[0]?.arm).toBe('openrouter');
  });
});
