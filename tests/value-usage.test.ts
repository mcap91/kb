/**
 * Tests for computeValueUsage (value-usage.ts) — the OWNED union-reader + LiteLLM-table cost
 * surface (WK-0066 / DEC-0005). The Claude, Codex, and dispatch (.agent-runs) reads are ours;
 * pricing is `tokens × a vendored pinned LiteLLM table`; aggregation is by model AND by provider;
 * the single cost surface is `est_usd` (no actual layer, no effort dimension). Local/self-hosted
 * dispatch runs (ollama endpoint) price to est_usd 0.
 *
 * Strategy: inject fake UsageDeps — readClaudeSessions / readCodexSessions / readDispatchUsage
 * return canned normalized records, loadPricingTable returns a small SYNTHETIC table (never the
 * 1.75 MB vendored one). Hermetic and fully offline: no network, no real ~/.claude / ~/.codex.
 *
 * Host-native synthetic fixtures only (WK-0043): DIR is derived per platform so it is
 * already absolute for the host running the suite (path.resolve is a no-op), symmetric on
 * Windows and Linux/WSL. The paths need not physically exist.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  UsageDeps,
  ClaudeMessageUsage,
  CodexSessionUsage,
} from '../packages/wiki-core/src/value-usage.js';
import {
  computeValueUsage,
  defaultReadDispatchUsage,
  isLocalEndpoint,
} from '../packages/wiki-core/src/value-usage.js';
import type { UsageRecord } from '../packages/wiki-core/src/types.js';
import type { PricingTable } from '../packages/wiki-core/src/pricing.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IS_WIN = process.platform === 'win32';
const SEP = IS_WIN ? '\\' : '/';
const HOME_ROOT = IS_WIN ? 'C:\\Users\\test\\projects' : '/home/test/projects';
const DIR = `${HOME_ROOT}${SEP}kb`;
const SINCE = '2026-07-01';
const UNTIL = '2026-07-10';

/** The encoded-cwd project key Claude Code emits for DIR (: \ / -> -). */
const ENCODED_DIR = DIR.replace(/[:\\/]/g, '-');

/**
 * A small synthetic LiteLLM table. Rates chosen so every product is clean and the two
 * providers (anthropic / openai) are distinguishable. Cache-write and cache-read carry
 * DISTINCT rates so a "priced at the input rate" regression is caught at the total level.
 */
const SYN_TABLE: PricingTable = {
  'claude-opus-4-8': {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00003,
    cache_creation_input_token_cost: 0.0000125,
    cache_read_input_token_cost: 0.000001,
    litellm_provider: 'anthropic',
  },
  'claude-sonnet-4-6': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_creation_input_token_cost: 0.00000375,
    cache_read_input_token_cost: 0.0000003,
    litellm_provider: 'anthropic',
  },
  'gpt-5.5': {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000008,
    cache_read_input_token_cost: 0.0000001,
    litellm_provider: 'openai',
  },
};

function claudeMsg(
  projectKey: string,
  messageId: string,
  model: string,
  toks: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): ClaudeMessageUsage {
  return {
    projectKey,
    messageId,
    model,
    date: '2026-07-05',
    input_tokens: toks.input ?? 0,
    output_tokens: toks.output ?? 0,
    cache_read_tokens: toks.cacheRead ?? 0,
    cache_write_tokens: toks.cacheWrite ?? 0,
  };
}

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

/**
 * Base deps: a synthetic pricing table, no worktrees, empty readers. Fully offline. The dispatch
 * reader defaults to [] (no injected records) so tests that don't exercise it read no real files.
 */
function baseDeps(over: Partial<UsageDeps> = {}): UsageDeps {
  return {
    readClaudeSessions: () => [],
    readCodexSessions: () => [],
    readDispatchUsage: () => [],
    loadPricingTable: () => SYN_TABLE,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Repo attribution (target vs other-repo vs worktree)
// ---------------------------------------------------------------------------

describe('attribution — Claude messages are scoped to the target repo', () => {
  it('includes the target project key and excludes a different project key', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 500 }),
        claudeMsg(
          (HOME_ROOT + SEP + 'other').replace(/[:\\/]/g, '-'),
          'b',
          'claude-opus-4-8',
          { input: 9999, output: 9999 },
        ),
      ],
    });

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.input_tokens).toBe(1000);
    expect(result.data.output_tokens).toBe(500);
    expect(result.data.total_tokens).toBe(1500);
    expect(result.data.agents).toContain('claude');
  });

  it('includes a message under a linked worktree project key via listWorktreeRoots', async () => {
    const WT_PATH = HOME_ROOT + SEP + 'kb-wt' + SEP + 'main';
    const WT_ENCODED = WT_PATH.replace(/[:\\/]/g, '-');
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(WT_ENCODED, 'w', 'claude-opus-4-8', { input: 2000, output: 800 }),
      ],
      listWorktreeRoots: () => [WT_PATH],
    });

    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_tokens).toBe(2800);
  });

  it('does not double-count when listWorktreeRoots echoes the main dir + duplicates', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 400 }),
      ],
      listWorktreeRoots: () => [DIR, DIR, HOME_ROOT + SEP + 'kb-wt'],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.by_model).toHaveLength(1);
    expect(result.data.total_tokens).toBe(1400);
  });
});

// ---------------------------------------------------------------------------
// Token extraction + dedup
// ---------------------------------------------------------------------------

describe('token extraction — all four buckets, per model', () => {
  it('parses input/output/cache_read/cache_write for a single model', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', {
          input: 1000,
          output: 500,
          cacheRead: 300,
          cacheWrite: 200,
        }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.data;
    expect(d.input_tokens).toBe(1000);
    expect(d.output_tokens).toBe(500);
    expect(d.cache_read_tokens).toBe(300);
    expect(d.cache_write_tokens).toBe(200);
    expect(d.total_tokens).toBe(2000);
    const m = d.by_model[0]!;
    expect(m.model).toBe('claude-opus-4-8');
    expect(m.provider).toBe('anthropic');
  });

  it('splits a two-model session into two by_model rows', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 100, output: 40 }),
        claudeMsg(ENCODED_DIR, 'b', 'claude-sonnet-4-6', { input: 200, output: 80 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.by_model).toHaveLength(2);
    expect(result.data.total_tokens).toBe(420);
  });
});

describe('dedup — a repeated message id is counted once', () => {
  it('collapses duplicate message.id records (resumed sessions / mirrored writes)', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'dup', 'claude-opus-4-8', { input: 1000, output: 500 }),
        claudeMsg(ENCODED_DIR, 'dup', 'claude-opus-4-8', { input: 1000, output: 500 }),
        claudeMsg(ENCODED_DIR, 'unique', 'claude-opus-4-8', { input: 10, output: 5 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only one 'dup' + the 'unique' one: 1000+500 + 10+5 = 1515
    expect(result.data.total_tokens).toBe(1515);
  });
});

// ---------------------------------------------------------------------------
// Pricing (tokens × table) + unknown-model null + reason
// ---------------------------------------------------------------------------

describe('pricing — tokens × table with distinct cache rates', () => {
  it('prices a claude model exactly into the single est_usd surface', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', {
          input: 1000,
          output: 500,
          cacheRead: 300,
          cacheWrite: 200,
        }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1000*1e-5 + 500*3e-5 + 200*1.25e-5 + 300*1e-6
    //   = 0.01   + 0.015   + 0.0025      + 0.0003   = 0.0278
    const m = result.data.by_model[0]!;
    expect(m.est_usd).toBeCloseTo(0.0278, 10);
    expect(m.est_reason).toBeNull();
    expect(result.data.est_usd).toBeCloseTo(0.0278, 10);
  });

  it('an unknown model prices to null + an explicit reason (never a silent $0)', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'mystery-model-9', { input: 1000, output: 500 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.data.by_model[0]!;
    expect(m.provider).toBe('unknown');
    expect(m.est_usd).toBeNull();
    expect(m.est_reason).toMatch(/mystery-model-9/);
    // Nothing priceable → total estimate is null, not 0.
    expect(result.data.est_usd).toBeNull();
    // Tokens still counted.
    expect(result.data.total_tokens).toBe(1500);
  });

  it('a non-exact remote id (provider-prefixed / slash-namespaced) fails loud — either in the table or null', async () => {
    // Why (WK-0066): the model-id override mechanism was removed. `z-ai/glm-5.2` is not an exact
    // vendored key, so it prices null + reason (fail loud) — never a substitute rate, never a silent
    // $0. Tokens are still counted. (If the operator wants it priced, the pinned table is re-vendored
    // per DEC-0005; there is no per-repo alias override.)
    const deps = baseDeps({
      readDispatchUsage: () => [
        {
          source: 'dispatch',
          model: 'z-ai/glm-5.2',
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          date: '2026-07-05',
          local: false,
        },
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.data.by_model[0]!;
    expect(m.provider).toBe('unknown');
    expect(m.est_usd).toBeNull();
    expect(m.est_reason).toMatch(/z-ai\/glm-5\.2/);
    expect(result.data.est_usd).toBeNull();
    expect(result.data.total_tokens).toBe(1500); // tokens still counted
  });
});

// ---------------------------------------------------------------------------
// by_provider aggregation
// ---------------------------------------------------------------------------

describe('by_provider — aggregates from litellm_provider', () => {
  it('sums same-provider models into one provider row and splits distinct providers', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 0 }),
        claudeMsg(ENCODED_DIR, 'b', 'claude-sonnet-4-6', { input: 2000, output: 0 }),
      ],
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 500, 0, 0)],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byProv = Object.fromEntries(result.data.by_provider.map((p) => [p.provider, p]));
    expect(Object.keys(byProv).sort()).toEqual(['anthropic', 'openai']);
    // anthropic input = 1000 + 2000 = 3000; openai input = 500
    expect(byProv.anthropic!.input_tokens).toBe(3000);
    expect(byProv.openai!.input_tokens).toBe(500);
    // anthropic est = 1000*1e-5 + 2000*3e-6 = 0.01 + 0.006 = 0.016
    expect(byProv.anthropic!.est_usd).toBeCloseTo(0.016, 10);
    // openai est = 500*1e-6 = 0.0005
    expect(byProv.openai!.est_usd).toBeCloseTo(0.0005, 10);
  });
});

// ---------------------------------------------------------------------------
// Dispatch .agent-runs reader (situations 3 + 7) — remote priced, local $0
// ---------------------------------------------------------------------------

/** A dispatch UsageRecord fixture (already repo-scoped + windowed by the reader). */
function dispatchRec(model: string, input: number, output: number, local: boolean): UsageRecord {
  return {
    source: 'dispatch',
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    date: '2026-07-05',
    local,
  };
}

describe('dispatch — .agent-runs sentinel: remote priced by table, local self-hosted → est_usd 0', () => {
  it('prices a remote (OpenRouter) dispatch model via the table', async () => {
    const deps = baseDeps({
      readDispatchUsage: () => [dispatchRec('gpt-5.5', 1000, 500, false)],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.data.by_model[0]!;
    expect(m.provider).toBe('openai');
    // 1000*1e-6 + 500*8e-6 = 0.001 + 0.004 = 0.005
    expect(m.est_usd).toBeCloseTo(0.005, 12);
    expect(result.data.agents).toEqual(['dispatch']);
  });

  it('prices a local/self-hosted (ollama) dispatch model to est_usd 0 (never null, never a counterfactual)', async () => {
    const deps = baseDeps({
      readDispatchUsage: () => [dispatchRec('qwen3-coder:30b', 2000, 1000, true)],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.data.by_model[0]!;
    expect(m.provider).toBe('local');
    expect(m.est_usd).toBe(0); // real 0, not null — no substitute-model rate
    expect(m.est_reason).toBeNull();
    expect(m.total_tokens).toBe(3000);
    // A local-only span totals est_usd 0, not null.
    expect(result.data.est_usd).toBe(0);
  });

  it('all sources union in one span: agents lists claude + codex + dispatch; est_usd sums the priced rows', async () => {
    // Why (WK-0066 AC): every capture path produces priced UsageRecords in one scrape — the union
    // is the coverage contract. Local dispatch contributes tokens + $0; remote/claude/codex price.
    const deps = baseDeps({
      readClaudeSessions: () => [claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 0 })],
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 500, 0, 0)],
      readDispatchUsage: () => [
        dispatchRec('claude-sonnet-4-6', 2000, 0, false), // remote (OR-through-dispatch)
        dispatchRec('qwen3-coder:30b', 400, 100, true), // local ollama → $0
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.agents).toEqual(['claude', 'codex', 'dispatch']);
    // est_usd = opus(1000*1e-5=0.01) + gpt(500*1e-6=0.0005) + sonnet(2000*3e-6=0.006) + local(0)
    expect(result.data.est_usd).toBeCloseTo(0.01 + 0.0005 + 0.006, 10);
    expect(result.data.total_tokens).toBe(1000 + 500 + 2000 + 500);
  });
});

describe('isLocalEndpoint — ollama endpoints are local, OpenRouter is remote', () => {
  it('classifies the ollama defaults as local and openrouter.ai as remote', () => {
    expect(isLocalEndpoint('http://localhost:11434')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:11434/api/chat')).toBe(true);
    expect(isLocalEndpoint('https://openrouter.ai/api/v1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Situation 5: dispatch-launched Claude cwd is a <repo>/.agent-runs/... subfolder
// ---------------------------------------------------------------------------

describe('claude attribution — situation 5: a bundle-nested cwd attributes to the repo (PREFIX)', () => {
  it('includes a Claude project key under <repo>/.agent-runs/... (was silently dropped by exact-match)', async () => {
    // Why (WK-0066): a dispatch-launched Claude runs with cwd = <repo>/.agent-runs/runs/<h>/RUN-x/
    // agent-visible, whose encoded key is <encodedRoot>-.agent-runs-... — an exact-equality scope
    // test dropped it. The encoded-root PREFIX match attributes it to the repo.
    const nestedCwd = DIR + SEP + '.agent-runs' + SEP + 'runs' + SEP + 'H' + SEP + 'RUN-x' + SEP + 'agent-visible';
    const nestedKey = nestedCwd.replace(/[:\\/]/g, '-');
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(nestedKey, 'nested', 'claude-opus-4-8', { input: 1234, output: 0 }),
        // A sibling with an unrelated name is still excluded (prefix boundary).
        claudeMsg((HOME_ROOT + SEP + 'other').replace(/[:\\/]/g, '-'), 'x', 'claude-opus-4-8', { input: 9, output: 9 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.input_tokens).toBe(1234);
    expect(result.data.total_tokens).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// Codex repo attribution (kept from the pre-ccusage behavior)
// ---------------------------------------------------------------------------

describe('codex — repo attribution by cwd prefix', () => {
  it('includes a dispatch subdir under the repo and excludes other/sibling repos', async () => {
    const deps = baseDeps({
      readCodexSessions: () => [
        codexSession(
          DIR + SEP + '.agent-runs' + SEP + 'RUN-x' + SEP + 'agent-visible',
          'gpt-5.5',
          100,
          200,
          50,
        ),
        codexSession(HOME_ROOT + SEP + 'other-repo', 'gpt-5.5', 99999, 0, 99999),
        codexSession(HOME_ROOT + SEP + 'kb-sandbox', 'gpt-5.5', 88888, 0, 88888), // sibling prefix
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_tokens).toBe(350); // only the .agent-runs session
    expect(result.data.input_tokens).toBe(100);
  });

  it('sums Claude + Codex in the same window; agents lists both', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 400 }),
      ],
      readCodexSessions: () => [codexSession(DIR, 'gpt-5.5', 200, 0, 100)],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_tokens).toBe(1700);
    expect(result.data.agents.sort()).toEqual(['claude', 'codex']);
    expect(result.data.by_model).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Single cost surface: est_usd only (no actual layer / no provenance split — WK-0066)
// ---------------------------------------------------------------------------

describe('cost surface — est_usd only; no actual / provenance / effort fields', () => {
  it('surfaces the tokens × table estimate and carries no removed cost fields', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 1000, output: 500 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The tokens × table estimate is the single interpretable figure.
    expect(result.data.est_usd).toBeGreaterThan(0);
    // WK-0064's dead "actual"/provenance/effort scaffolding is gone from the surface.
    const asRecord = result.data as unknown as Record<string, unknown>;
    expect(asRecord.cost_usd).toBeUndefined();
    expect(asRecord.cost_usd_est).toBeUndefined();
    expect(asRecord.cost_provenance).toBeUndefined();
    expect(asRecord.actual_reason).toBeUndefined();
    expect(result.data.by_model[0] as unknown as Record<string, unknown>).not.toHaveProperty('effort');
  });
});

// ---------------------------------------------------------------------------
// Provenance stamp + self-awareness
// ---------------------------------------------------------------------------

describe('provenance — pinned table version is stamped', () => {
  it('surfaces the LiteLLM table version on every result', async () => {
    const deps = baseDeps({
      readClaudeSessions: () => [
        claudeMsg(ENCODED_DIR, 'a', 'claude-opus-4-8', { input: 10, output: 5 }),
      ],
    });
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pricing_table_version).toContain('94a29e07');
  });
});

describe('self-aware — no token data for the span is ok(), not fail()', () => {
  it('returns a reason (the unavailable signal) + zeroed totals when every reader yields zero', async () => {
    const deps = baseDeps(); // empty readers
    const result = await computeValueUsage({ dir: DIR, since: SINCE, until: UNTIL }, deps);
    expect(result.ok).toBe(true); // MUST be ok(), never fail()
    if (!result.ok) return;
    // The `reason` field (present) is the "unavailable" signal now that cost_provenance is gone.
    expect(result.data.reason).toBeDefined();
    expect(result.data.total_tokens).toBe(0);
    expect(result.data.by_model).toEqual([]);
    expect(result.data.by_provider).toEqual([]);
    expect(result.data.agents).toEqual([]);
    expect(result.data.est_usd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dispatch reader over REAL .agent-runs files (host-native temp fixture; offline, no ~/.claude)
// ---------------------------------------------------------------------------

describe('defaultReadDispatchUsage — reads real <repo>/.agent-runs bundles, windows, classifies local', () => {
  let repo: string;

  function writeBundle(
    root: string,
    handoff: string,
    run: string,
    usage: Record<string, unknown>,
    completedAt: string,
  ): void {
    const metaDir = path.join(root, '.agent-runs', 'runs', handoff, run, 'metadata');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, 'usage.json'), JSON.stringify(usage), 'utf-8');
    fs.writeFileSync(path.join(metaDir, 'meta.json'), JSON.stringify({ completed_at: completedAt }), 'utf-8');
  }

  afterEach(() => {
    if (repo) {
      try {
        fs.rmSync(repo, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('ingests an in-window sentinel (remote + local), windows out an old one — offline, repo-local', () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dispatch-read-'));
    writeBundle(
      repo, 'H1', 'RUN-a',
      { model: 'z-ai/glm-5.2', endpoint: 'https://openrouter.ai/api/v1', prompt_tokens: 1000, completion_tokens: 500 },
      '2026-07-05T10:00:00Z',
    );
    writeBundle(
      repo, 'H2', 'RUN-b',
      { model: 'qwen3-coder:30b', endpoint: 'http://localhost:11434', prompt_tokens: 200, completion_tokens: 100 },
      '2026-07-06T10:00:00Z',
    );
    writeBundle(
      repo, 'H3', 'RUN-c',
      { model: 'gpt-5.5', endpoint: 'https://openrouter.ai/api/v1', prompt_tokens: 9999, completion_tokens: 9999 },
      '2026-06-01T10:00:00Z', // out of window
    );

    const recs = defaultReadDispatchUsage({ since: '2026-07-01', until: '2026-07-10', roots: [repo] });
    const byModel = Object.fromEntries(recs.map((r) => [r.model, r]));
    expect(Object.keys(byModel).sort()).toEqual(['qwen3-coder:30b', 'z-ai/glm-5.2']);
    expect(byModel['z-ai/glm-5.2']!.local).toBe(false);
    expect(byModel['z-ai/glm-5.2']!.input_tokens).toBe(1000); // prompt_tokens → input
    expect(byModel['z-ai/glm-5.2']!.output_tokens).toBe(500); // completion_tokens → output
    expect(byModel['qwen3-coder:30b']!.local).toBe(true); // ollama endpoint → local
  });

  it('returns [] when the repo has no .agent-runs bundle (absent store → never throws)', () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dispatch-empty-'));
    expect(defaultReadDispatchUsage({ since: '2026-07-01', until: '2026-07-10', roots: [repo] })).toEqual([]);
  });
});

// (The former "secrets never logged" test was removed with the OpenRouter layer — the tool no
// longer reads any key or makes any network call, so there is no secret to leak.)
