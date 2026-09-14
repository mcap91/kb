/**
 * PLN-0004 S5 Wave 2 — pipeline.ts integration tests for the S5 required-
 * enforcement wiring (tier resolution, full jail args, tunnel splice,
 * lockfile-gated dependency provisioning, honest isolationBackend
 * provenance).
 *
 * `buildExecutionScript` and `toJailDataMount` are pure, synchronous helpers
 * pipeline.ts exports at module scope specifically so this integration can be
 * covered with string-content tests against the generated script, NOT a live
 * WSL2/bwrap/Pi host (mirrors dispatch-v2-tunnel.test.ts / dispatch-v2-jail.
 * test.ts / dispatch-v2-tier.test.ts's own no-live-host coverage for the W1
 * modules these tests wire together). The one true end-to-end integration
 * point that needs a real repo fixture — the NO_ISOLATION_ROUTE refusal
 * firing off REAL tier resolution rather than a hardcoded isolationBackend —
 * lives in tests/dispatch-v2-e2e.test.ts alongside its existing mocked-
 * preflight refusal-gate tests. No personal/absolute paths in fixtures
 * (WK-0043 rule) — all paths below are synthetic.
 */
import { describe, expect, it } from 'vitest';

import {
  buildExecutionScript,
  toJailDataMount,
  needsWinHostResolution,
  applyWinHost,
  type BuildExecutionScriptOpts,
} from '../packages/dispatch-core/src/pipeline.js';
import { buildJailArgs } from '../packages/dispatch-core/src/jail.js';
import {
  buildTunnelBashLines,
  TUNNEL_RELAY_PORT,
  TUNNEL_SOCKET_NAME,
  type TunnelConfig,
} from '../packages/dispatch-core/src/tunnel.js';
import { buildInvocation } from '../packages/dispatch-core/src/adapters/pi.js';
import type { ModelEntry } from '../packages/dispatch-core/src/model-registry.js';
import type { InjectionScriptLines } from '../packages/dispatch-core/src/credentials.js';

// ---------------------------------------------------------------------------
// Shared fixtures — mirror exactly what runDispatch() itself constructs, so
// these tests exercise the real wiring shape rather than a hand-simplified
// stand-in.
// ---------------------------------------------------------------------------

const clonePath = '/home/user/.kb-dispatch/clones/RUN-S5TEST';
const runDirWsl = '/mnt/c/Users/test/.kb-dispatch/runs/HO-0001/RUN-S5TEST';
// workerDir is a path INSIDE THE JAIL (bwrap's fresh /tmp tmpfs, jail.ts step
// 4), never under clonePath — see pipeline.ts's own workerDir comment (the
// EROFS fix: clonePath is read-only outside write_scope since S5).
const workerDir = '/tmp/.pi-agent';
const promptPathWsl = `${runDirWsl}/prompt.txt`;
const tunnelSocketWsl = `${runDirWsl}/${TUNNEL_SOCKET_NAME}`;
const relayScriptWsl = `${runDirWsl}/relay.js`;

const emptyInjectionScript: InjectionScriptLines = {
  exportLines: [],
  varsExportLines: [],
  existenceCheckLines: [],
};

/** The exact loopback baseUrl pipeline.ts's new S5 code builds (piBaseUrl). */
const piBaseUrl = `http://127.0.0.1:${TUNNEL_RELAY_PORT}`;

function buildFixtureInvocation(baseUrl: string) {
  const piModelEntry: ModelEntry = {
    provider: 'ollama',
    modelId: 'qwen3:8b',
    displayName: 'qwen3:8b (ollama)',
    baseUrl,
    api: 'openai-completions',
    apiKeyEnv: null,
    contextWindow: 32768,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return buildInvocation(promptPathWsl, piModelEntry, clonePath, workerDir);
}

function buildFixtureTunnelBash(webEnabled = false) {
  const tunnelConfig: TunnelConfig = {
    socketPath: tunnelSocketWsl,
    targetUrl: 'http://172.26.0.1:11434/v1',
    webEnabled,
    relayPort: TUNNEL_RELAY_PORT,
    logPath: `${runDirWsl}/tunnel-destinations.log`,
  };
  return buildTunnelBashLines(tunnelConfig, runDirWsl);
}

function buildFixtureJailArgv() {
  return buildJailArgs({
    clonePath,
    writeScope: ['src/', 'test/'],
    wikiShape: 'nested-private',
    mode: 'implement',
    dataMounts: [],
    unshareNet: true,
    tunnelSocketPath: tunnelSocketWsl,
    relayScriptPath: relayScriptWsl,
  }).argv;
}

function buildFixtureOpts(overrides: Partial<BuildExecutionScriptOpts> = {}): BuildExecutionScriptOpts {
  const invocation = buildFixtureInvocation(piBaseUrl);
  return {
    injectionScript: emptyInjectionScript,
    workerDir,
    modelsJsonContent: invocation.modelsJsonContent,
    fingerprintLines: ['_FP_HOST=\'127.0.0.1\'', 'echo "BACKEND_FINGERPRINT=$_FP_HOST|$_FP_MODEL|$_FP_VERSION"'],
    runDirWsl,
    clonePath,
    jailArgv: buildFixtureJailArgv(),
    workerCmd: invocation.cmd,
    workerArgs: invocation.args,
    tunnelBash: buildFixtureTunnelBash(),
    workerTimeoutSecs: 1800,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildExecutionScript — tunnel splice (T26/D21)
// ---------------------------------------------------------------------------

describe('buildExecutionScript — tunnel splice', () => {
  it('stages both the forwarder and relay scripts via quoted heredocs', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toContain("cat <<'TUNNEL_FORWARDER_EOF'");
    expect(script).toContain("cat <<'TUNNEL_RELAY_EOF'");
    expect(script).toContain(`${runDirWsl}/forwarder.js`);
    expect(script).toContain(relayScriptWsl);
  });

  it('starts the host-side forwarder and exports proxy env vars before the jail runs', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toMatch(/node .*forwarder\.js.* &$/m);
    expect(script).toContain('FORWARDER_PID=$!');
    expect(script).toContain(`export HTTP_PROXY='http://127.0.0.1:${TUNNEL_RELAY_PORT}'`);
  });

  it('brings the loopback interface up inside the jail before starting the relay', () => {
    expect(buildExecutionScript(buildFixtureOpts())).toContain('ip link set lo up');
  });

  it('orders lo-up before the relay start inside the jail', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    const loIndex = script.indexOf('ip link set lo up');
    const relayStartIndex = script.indexOf('RELAY_PID=$!');
    expect(loIndex).toBeGreaterThanOrEqual(0);
    expect(relayStartIndex).toBeGreaterThan(loIndex);
  });

  it('kills the in-jail relay and the host-side forwarder somewhere in the script', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toContain('kill $RELAY_PID');
    expect(script).toContain('kill $FORWARDER_PID');
    expect(script).toContain('wait $FORWARDER_PID');
  });

  it('kills the host-side forwarder AFTER the bwrap/timeout invocation, not before', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    const bwrapIndex = script.indexOf('timeout --signal=TERM');
    const forwarderKillIndex = script.indexOf('kill $FORWARDER_PID');
    expect(bwrapIndex).toBeGreaterThanOrEqual(0);
    expect(forwarderKillIndex).toBeGreaterThan(bwrapIndex);
  });

  it('tears down the forwarder even when the bwrap/timeout pipeline is embedded in an if/else (survives set -e)', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toContain('set -euo pipefail');
    // The bwrap invocation embeds the (multi-line) inner script as one
    // shQuote'd argv element, so "if timeout ... ; then" is not a single
    // physical line — assert the pieces independently rather than with one
    // contiguous no-newline regex.
    expect(script).toContain('if timeout --signal=TERM --kill-after=30s "$WORKER_TIMEOUT_SECS"');
    expect(script).toContain('| tee "$PI_LOG"; then');
    expect(script).toContain('DISPATCH_EXIT_CODE=0');
    // Search for the bash `else` as its OWN line (`\nelse\n`), not a bare
    // substring match — the embedded forwarder.js source (spliced in earlier,
    // via tunnelBash.preJailLines) itself contains a JS "} else {" branch,
    // which a plain indexOf('else') would find first and give a false ordering.
    expect(script.indexOf('\nelse\n')).toBeGreaterThan(script.indexOf('DISPATCH_EXIT_CODE=0'));
    expect(script).toContain('DISPATCH_EXIT_CODE=$?');
    expect(script).toContain('exit "$DISPATCH_EXIT_CODE"');
  });

  it('passes web:false through to the forwarder by default', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toMatch(/node .*forwarder\.js[^\n]*'false'/);
  });

  it('passes web:true through to the forwarder when the tunnel config grants it', () => {
    const script = buildExecutionScript(buildFixtureOpts({ tunnelBash: buildFixtureTunnelBash(true) }));
    expect(script).toMatch(/node .*forwarder\.js[^\n]*'true'/);
  });
});

// ---------------------------------------------------------------------------
// buildExecutionScript — full jail args wired through (--unshare-net, T15/T26)
// ---------------------------------------------------------------------------

describe('buildExecutionScript — full jail args', () => {
  it('includes --unshare-net from the caller-supplied jailArgv', () => {
    expect(buildExecutionScript(buildFixtureOpts())).toContain('--unshare-net');
  });

  it('wraps the bwrap invocation around a `bash -c` inner script rather than a bare worker command', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toContain("'bash' '-c'");
  });

  it('embeds the exact S0-minimum argv unchanged when the caller passes it (backward-compat shape)', () => {
    // Not a "no --unshare-net anywhere in the script" claim — the embedded
    // relay.js source (tunnelBash.preJailLines, always spliced in
    // independently of jailArgv) self-documents that it runs "inside the
    // --unshare-net network namespace", so that substring is always present
    // regardless of what jailArgv itself carries. What actually matters here
    // is that buildExecutionScript passes the caller's jailArgv through
    // byte-for-byte — assert on the S0-minimum argv's own distinctive
    // sequence instead of a substring that collides with tunnel.ts's prose.
    const s0Argv = buildJailArgs({ clonePath }).argv; // no S5 options -> S0-minimum shape
    expect(s0Argv).not.toContain('--unshare-net'); // sanity: the fixture itself has none
    const script = buildExecutionScript(buildFixtureOpts({ jailArgv: s0Argv }));
    expect(script).toContain(s0Argv.map((tok) => `'${tok}'`).join(' '));
  });
});

// ---------------------------------------------------------------------------
// buildExecutionScript — models.json baseUrl rewrite (T26 routing)
// ---------------------------------------------------------------------------

describe('buildExecutionScript — models.json baseUrl rewrite', () => {
  it('embeds the in-jail loopback baseUrl in the models.json heredoc, not {{WIN_HOST}}', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toContain(`http://127.0.0.1:${TUNNEL_RELAY_PORT}`);
    expect(script).not.toContain('{{WIN_HOST}}');
  });

  it('no longer emits the retired WIN_HOST sed substitution for models.json', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).not.toContain('sed -i "s/{{WIN_HOST}}/$WIN_HOST/g"');
  });

  it('still writes models.json via a quote-delimited heredoc (Pi\'s own $VAR apiKey placeholders stay unexpanded)', () => {
    const invocation = buildFixtureInvocation(piBaseUrl);
    const script = buildExecutionScript(buildFixtureOpts({ modelsJsonContent: invocation.modelsJsonContent }));
    // The heredoc now lives inside the shQuote'd `bash -c` inner-script blob
    // (S5 EROFS fix, see the describe block below), so its own single quotes
    // round-trip escaped (`'\''`) rather than bare in the raw script text —
    // assert on the quote-free pieces (heredoc tag + target path + body)
    // instead of the exact `<<'...'` substring.
    expect(script).toContain('DISPATCH_MODELS_JSON_EOF');
    expect(script).toContain('$PI_CODING_AGENT_DIR/models.json');
    expect(script).toContain(invocation.modelsJsonContent);
  });
});

// ---------------------------------------------------------------------------
// needsWinHostResolution / applyWinHost — S6a fix: the tunnel forwarder's
// real target URL must resolve a loopback hostname to the Windows host's IP
// on bwrap-wsl2 ONLY (the forwarder runs outside bwrap but still inside
// WSL2, so an unresolved `localhost` would have it dial WSL2's own loopback,
// never reaching Windows-side Ollama), never on bwrap-direct (native Linux,
// e.g. EC2, where the forwarder and the backend already share one host).
// Pure/synchronous — asserted directly, the same way toJailDataMount above
// is, rather than through a live-WSL2 `runDispatch()` call: pipeline.ts's
// step 10b (where these are actually wired in) is reached only after real
// clone/WSL2 work runs, well past what this suite's fake-tier convention
// covers (see tests/dispatch-v2-e2e.test.ts's own docstring on this exact
// boundary).
// ---------------------------------------------------------------------------

describe('needsWinHostResolution — gated to bwrap-wsl2 only', () => {
  it('is true for a bare "localhost" base_url on bwrap-wsl2 (the live S6a gate-1 bug)', () => {
    expect(needsWinHostResolution('http://localhost:11434/v1', 'bwrap-wsl2')).toBe(true);
  });

  it('is true for a bare "127.0.0.1" base_url on bwrap-wsl2', () => {
    expect(needsWinHostResolution('http://127.0.0.1:11434/v1', 'bwrap-wsl2')).toBe(true);
  });

  it('is true for a "0.0.0.0" base_url on bwrap-wsl2 (defensive: same local-stack failure mode)', () => {
    expect(needsWinHostResolution('http://0.0.0.0:11434/v1', 'bwrap-wsl2')).toBe(true);
  });

  it('is true for the legacy {{WIN_HOST}} template on bwrap-wsl2 (S0 seed registry back-compat)', () => {
    expect(needsWinHostResolution('http://{{WIN_HOST}}:11434/v1', 'bwrap-wsl2')).toBe(true);
  });

  it('is false for the identical "localhost" base_url on bwrap-direct (EC2: same-host, localhost is already correct)', () => {
    expect(needsWinHostResolution('http://localhost:11434/v1', 'bwrap-direct')).toBe(false);
  });

  it('is false for "127.0.0.1" on bwrap-direct', () => {
    expect(needsWinHostResolution('http://127.0.0.1:11434/v1', 'bwrap-direct')).toBe(false);
  });

  it('is false on pod-attested (no Windows host in the picture)', () => {
    expect(needsWinHostResolution('http://localhost:11434/v1', 'pod-attested')).toBe(false);
  });

  it('is false when no isolation route resolved (tier === null)', () => {
    expect(needsWinHostResolution('http://localhost:11434/v1', null)).toBe(false);
  });

  it('is false for a real remote HTTPS endpoint on bwrap-wsl2 (no pointless round trip)', () => {
    expect(needsWinHostResolution('https://openrouter.ai/api/v1', 'bwrap-wsl2')).toBe(false);
  });

  it('degrades to false for an unparseable base_url rather than throwing', () => {
    expect(needsWinHostResolution('not-a-url', 'bwrap-wsl2')).toBe(false);
  });
});

describe('applyWinHost — rewrites the host, preserves port and path', () => {
  it('rewrites a bare "localhost" host to the resolved WIN_HOST IP', () => {
    expect(applyWinHost('http://localhost:11434/v1', '172.26.0.1')).toBe('http://172.26.0.1:11434/v1');
  });

  it('rewrites a bare "127.0.0.1" host to the resolved WIN_HOST IP', () => {
    expect(applyWinHost('http://127.0.0.1:11434/v1', '172.26.0.1')).toBe('http://172.26.0.1:11434/v1');
  });

  it('substitutes the legacy {{WIN_HOST}} template', () => {
    expect(applyWinHost('http://{{WIN_HOST}}:11434/v1', '172.26.0.1')).toBe('http://172.26.0.1:11434/v1');
  });
});

// ---------------------------------------------------------------------------
// buildExecutionScript — PI_CODING_AGENT_DIR setup runs INSIDE the jail
// (S5 EROFS regression fix: workerDir moved to /tmp/.pi-agent, a path only
// bwrap's own --tmpfs /tmp mount creates; anything written pre-jail to that
// path lands on the wrong /tmp and is invisible once bwrap starts)
// ---------------------------------------------------------------------------

describe('buildExecutionScript — PI_CODING_AGENT_DIR setup runs INSIDE the jail (S5 EROFS fix)', () => {
  it('exports PI_CODING_AGENT_DIR/PI_OFFLINE pre-jail (env vars ARE inherited by the bwrap child)', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    const exportIndex = script.indexOf(`export PI_CODING_AGENT_DIR='${workerDir}'`);
    const innerScriptStart = script.indexOf("'bash' '-c'");
    expect(exportIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeLessThan(innerScriptStart);
  });

  it('creates PI_CODING_AGENT_DIR (mkdir) INSIDE the bash -c inner script, not pre-jail', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    const innerScriptStart = script.indexOf("'bash' '-c'");
    const mkdirIndex = script.indexOf('mkdir -p "$PI_CODING_AGENT_DIR"');
    expect(innerScriptStart).toBeGreaterThanOrEqual(0);
    expect(mkdirIndex).toBeGreaterThan(innerScriptStart);
    // Exactly one mkdir for it — no leftover pre-jail duplicate.
    expect(script.split('mkdir -p "$PI_CODING_AGENT_DIR"').length - 1).toBe(1);
  });

  it('writes the models.json heredoc (both markers) INSIDE the bash -c inner script, not pre-jail', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    const innerScriptStart = script.indexOf("'bash' '-c'");
    const markerIndices = [...script.matchAll(/DISPATCH_MODELS_JSON_EOF/g)].map((m) => m.index!);
    expect(markerIndices).toHaveLength(2); // heredoc open + close
    for (const idx of markerIndices) {
      expect(idx).toBeGreaterThan(innerScriptStart);
    }
  });
});

// ---------------------------------------------------------------------------
// buildExecutionScript — lockfile-gated dependency provisioning (s5-rulings.md ruling 2)
// ---------------------------------------------------------------------------

describe('buildExecutionScript — lockfile-gated dependency provisioning', () => {
  it('runs npm ci --ignore-scripts PRE-bwrap, gated on package-lock.json presence', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toContain(`if [ -f '${clonePath}/package-lock.json' ]; then`);
    expect(script).toContain('npm ci --ignore-scripts');
  });

  it('places the pre-bwrap npm ci BEFORE the bwrap/timeout invocation', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    const npmCiIndex = script.indexOf('npm ci --ignore-scripts');
    const bwrapIndex = script.indexOf('timeout --signal=TERM');
    expect(npmCiIndex).toBeGreaterThanOrEqual(0);
    expect(bwrapIndex).toBeGreaterThan(npmCiIndex);
  });

  it('runs npm rebuild INSIDE the jail (after the relay starts), never pre-bwrap', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toContain('npm rebuild 2>&1');
    // Exactly one pre-bwrap `npm ci` and one in-jail `npm rebuild` command
    // line (searching the actual command, not the bare word "npm rebuild" —
    // that phrase also appears once in this function's own explanatory
    // comment text, which would otherwise double-count).
    const npmCiOccurrences = script.split('npm ci --ignore-scripts').length - 1;
    const npmRebuildOccurrences = script.split('npm rebuild 2>&1').length - 1;
    expect(npmCiOccurrences).toBe(1);
    expect(npmRebuildOccurrences).toBe(1);
  });

  it('tolerates a failed npm ci/rebuild (never blocks the worker from running)', () => {
    const script = buildExecutionScript(buildFixtureOpts());
    expect(script).toContain('npm ci --ignore-scripts 2>&1 || true');
    expect(script).toContain('npm rebuild 2>&1 && cd - > /dev/null || true');
  });
});

// ---------------------------------------------------------------------------
// buildExecutionScript — credential injection still spliced in correctly (S3 regression guard)
// ---------------------------------------------------------------------------

describe('buildExecutionScript — credential injection ordering (S3 regression guard)', () => {
  it('places existence checks, exports, and models.json in the same relative order as before S5', () => {
    const injectionScript: InjectionScriptLines = {
      existenceCheckLines: ['if ! grep -q \'^HF_TOKEN=\' \'/home/op/.secrets/hf.env\'; then echo "CREDENTIAL_NOT_CONFIGURED:HF_TOKEN"; exit 1; fi'],
      exportLines: ['export HF_TOKEN="$(grep -m1 \'^HF_TOKEN=\' \'/home/op/.secrets/hf.env\' | cut -d= -f2-)"'],
      varsExportLines: ['export SOME_VAR=\'literal\''],
    };
    const script = buildExecutionScript(buildFixtureOpts({ injectionScript }));

    const existenceIndex = script.indexOf('CREDENTIAL_NOT_CONFIGURED:HF_TOKEN');
    const exportIndex = script.indexOf('export HF_TOKEN=');
    const varsIndex = script.indexOf("export SOME_VAR='literal'");
    const modelsJsonIndex = script.indexOf('DISPATCH_MODELS_JSON_EOF');

    expect(existenceIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThan(existenceIndex);
    expect(varsIndex).toBeGreaterThan(exportIndex);
    expect(modelsJsonIndex).toBeGreaterThan(varsIndex);
  });
});

// ---------------------------------------------------------------------------
// buildExecutionScript — purity
// ---------------------------------------------------------------------------

describe('buildExecutionScript — purity', () => {
  it('is pure: structurally identical inputs produce identical output', () => {
    const a = buildExecutionScript(buildFixtureOpts());
    const b = buildExecutionScript(buildFixtureOpts());
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// toJailDataMount — admission's suffix-form Windows path -> jail.ts's
// prefix-form WSL2 path
// ---------------------------------------------------------------------------

describe('toJailDataMount — data_mounts format bridge (admission suffix-form -> jail.ts prefix-form)', () => {
  it('converts a Windows :ro entry to WSL2 ro: prefix form', () => {
    expect(toJailDataMount('C:\\Users\\op\\reference-data:ro')).toBe('ro:/mnt/c/Users/op/reference-data');
  });

  it('converts a Windows :rw entry to WSL2 rw: prefix form', () => {
    expect(toJailDataMount('C:\\Users\\op\\scratch:rw')).toBe('rw:/mnt/c/Users/op/scratch');
  });

  it('round-trips through buildJailArgs into the correct bwrap bind flag', () => {
    const roEntry = toJailDataMount('D:\\data\\reference:ro');
    expect(roEntry).toBe('ro:/mnt/d/data/reference');
    const result = buildJailArgs({ clonePath, dataMounts: [roEntry] });
    // The data mount itself must be read-only-bound (as a consecutive
    // triple) — buildJailArgs also `--bind`s the clone path writable (legacy
    // shape, since no writeScope was given here), so this asserts the
    // specific triple rather than blanket-asserting no `--bind` appears
    // anywhere in the full argv.
    const idx = result.argv.indexOf('--ro-bind', result.argv.indexOf('--die-with-parent'));
    expect(idx).toBeGreaterThan(0);
    expect(result.argv[idx + 1]).toBe('/mnt/d/data/reference');
    expect(result.argv[idx + 2]).toBe('/mnt/d/data/reference');
  });

  it('leaves an entry with no recognizable :ro/:rw suffix unchanged (matches admission.ts mountPathOf leniency)', () => {
    expect(toJailDataMount('C:\\Users\\op\\no-suffix')).toBe('C:\\Users\\op\\no-suffix');
  });

  it('is a no-op for an already-POSIX path (native-Linux forward-compat)', () => {
    expect(toJailDataMount('/data/reference:ro')).toBe('ro:/data/reference');
  });
});
