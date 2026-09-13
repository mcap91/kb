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
const workerDir = `${clonePath}/.pi-agent`;
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
    expect(script).toContain(`cat <<'DISPATCH_MODELS_JSON_EOF' > "$PI_CODING_AGENT_DIR/models.json"`);
    expect(script).toContain(invocation.modelsJsonContent);
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
