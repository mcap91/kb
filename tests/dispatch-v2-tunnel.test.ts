/**
 * PLN-0004 S5 T26 — network egress tunnel code-generation tests.
 *
 * `tunnel.ts` is pure code generation: it builds self-contained Node.js
 * script TEXT (the host-side forwarder + the in-jail relay) and bash line
 * groups for pipeline.ts (a later wave, W2) to splice into the execution
 * script. It never starts a process, opens a socket, or spawns anything
 * itself, so these are all string/content verification tests — no live
 * networking here (that is T17/T29's job at the live-test tier). The
 * generated scripts were additionally smoke-tested by hand against real WSL2
 * unix sockets (origin-form + absolute-URI + CONNECT routing, web:false
 * destination refusal, web:true open egress, unbuffered SSE-style streaming,
 * and the full TCP-relay -> socket -> forwarder -> target chain) before this
 * suite was written; that exercise is not itself part of the committed
 * suite, per the task's no-live-networking instruction.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  buildTunnelBashLines,
  buildTunnelScripts,
  TUNNEL_RELAY_PORT,
  TUNNEL_SOCKET_NAME,
} from '../packages/dispatch-core/src/tunnel.js';
import type { TunnelConfig } from '../packages/dispatch-core/src/tunnel.js';

const baseConfig: TunnelConfig = {
  socketPath: '/mnt/c/Users/test/.kb-dispatch/runs/HO-0001/RUN-1/tunnel.sock',
  targetUrl: 'http://172.26.0.1:11434/v1',
  allowedHosts: ['172.26.0.1'],
  webEnabled: false,
};

const runDirWsl = '/mnt/c/Users/test/.kb-dispatch/runs/HO-0001/RUN-1';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('tunnel constants', () => {
  it('TUNNEL_RELAY_PORT defaults to 18787', () => {
    expect(TUNNEL_RELAY_PORT).toBe(18787);
  });

  it('TUNNEL_SOCKET_NAME is "tunnel.sock"', () => {
    expect(TUNNEL_SOCKET_NAME).toBe('tunnel.sock');
  });
});

// ---------------------------------------------------------------------------
// buildTunnelScripts
// ---------------------------------------------------------------------------

describe('buildTunnelScripts', () => {
  it('returns non-empty forwarder and relay script content', () => {
    const { forwarderScript, relayScript } = buildTunnelScripts(baseConfig);
    expect(forwarderScript.length).toBeGreaterThan(0);
    expect(relayScript.length).toBeGreaterThan(0);
  });

  it('is pure -- structurally identical config produces identical output', () => {
    const a = buildTunnelScripts(baseConfig);
    const b = buildTunnelScripts({ ...baseConfig });
    expect(a).toEqual(b);
  });

  describe('forwarder script', () => {
    const { forwarderScript } = buildTunnelScripts(baseConfig);

    it('parses argv for socket path, target URL, web flag, and log path', () => {
      expect(forwarderScript).toContain('process.argv');
      expect(forwarderScript).toContain('SOCKET_PATH');
      expect(forwarderScript).toContain('TARGET_URL');
      expect(forwarderScript).toContain('WEB_ENABLED');
      expect(forwarderScript).toContain('LOG_PATH');
    });

    it('creates an HTTP server', () => {
      expect(forwarderScript).toContain('http.createServer');
    });

    it('listens on the unix socket path', () => {
      expect(forwarderScript).toContain('server.listen(SOCKET_PATH');
    });

    it('uses only Node built-in modules (node: prefix), never an npm package', () => {
      expect(forwarderScript).toContain("require('node:http')");
      expect(forwarderScript).toContain("require('node:https')");
      expect(forwarderScript).toContain("require('node:net')");
      expect(forwarderScript).toContain("require('node:fs')");
      expect(forwarderScript).toContain("require('node:url')");
      expect(forwarderScript).not.toMatch(/require\(['"](?!node:)/);
    });

    it('logs every attempted destination with an allow/deny verdict (redteam forensics)', () => {
      expect(forwarderScript).toContain('logDestination');
      expect(forwarderScript).toContain('appendFileSync');
      expect(forwarderScript).toContain('LOG_PATH');
      expect(forwarderScript).toMatch(/allowed.*denied|denied.*allowed/);
    });

    it('handles the CONNECT method for HTTPS tunneling', () => {
      expect(forwarderScript).toContain("server.on('connect'");
    });

    it('handles absolute-URI HTTP forwarding (both http and https)', () => {
      expect(forwarderScript).toContain("startsWith('http://')");
      expect(forwarderScript).toContain("startsWith('https://')");
    });

    it('gates forwarding on a destination policy keyed on the web-enabled flag', () => {
      expect(forwarderScript).toContain('destinationAllowed');
      expect(forwarderScript).toContain('WEB_ENABLED');
      expect(forwarderScript).toContain('TARGET.hostname');
    });

    it('pipes/streams responses instead of buffering them (SSE safety)', () => {
      expect(forwarderScript).toContain('upstreamRes.pipe(res)');
      expect(forwarderScript).toContain('req.pipe(upstreamReq)');
      expect(forwarderScript).toContain('upstreamSocket.pipe(clientSocket)');
      expect(forwarderScript).toContain('clientSocket.pipe(upstreamSocket)');
      // Never collects a full body before responding.
      expect(forwarderScript).not.toContain('.text()');
      expect(forwarderScript).not.toContain('.json()');
      expect(forwarderScript).not.toMatch(/await\s+[\w.]+\.(text|json|buffer)\(/);
    });

    it('originates TLS at the forwarder for https destinations (never inside the jail)', () => {
      expect(forwarderScript).toContain('destIsTls ? https : http');
    });

    it('clears a stale socket file before binding to avoid a leftover-EADDRINUSE', () => {
      expect(forwarderScript).toContain('unlinkSync(SOCKET_PATH)');
    });

    it('exits with a usage message when required argv is missing', () => {
      expect(forwarderScript).toContain('usage: node forwarder.js');
      expect(forwarderScript).toContain('process.exit(1)');
    });
  });

  describe('relay script', () => {
    const { relayScript } = buildTunnelScripts(baseConfig);

    it('parses argv for relay port and socket path', () => {
      expect(relayScript).toContain('process.argv');
      expect(relayScript).toContain('PORT_ARG');
      expect(relayScript).toContain('SOCKET_PATH');
    });

    it('creates a TCP server', () => {
      expect(relayScript).toContain('net.createServer');
    });

    it('connects to the bind-mounted unix socket for each accepted connection', () => {
      expect(relayScript).toContain('net.connect(SOCKET_PATH)');
    });

    it('pipes bidirectionally without buffering', () => {
      expect(relayScript).toContain('clientSocket.pipe(upstream)');
      expect(relayScript).toContain('upstream.pipe(clientSocket)');
    });

    it('uses only node:net -- no npm packages, no HTTP awareness', () => {
      expect(relayScript).toContain("require('node:net')");
      expect(relayScript).not.toMatch(/require\(['"](?!node:)/);
    });

    it('listens on 127.0.0.1 and embeds the default relay port as a fallback', () => {
      expect(relayScript).toContain("server.listen(PORT, '127.0.0.1'");
      expect(relayScript).toContain(String(TUNNEL_RELAY_PORT));
    });

    it('honors a custom relayPort as the embedded default fallback', () => {
      const { relayScript: customRelay } = buildTunnelScripts({ ...baseConfig, relayPort: 19999 });
      expect(customRelay).toContain('19999');
      expect(customRelay).not.toContain(`|| ${TUNNEL_RELAY_PORT}`);
    });

    it('handles connection errors gracefully, tearing down both ends', () => {
      expect(relayScript).toContain("clientSocket.on('error'");
      expect(relayScript).toContain("upstream.on('error'");
    });

    it('exits with a usage message when required argv is missing', () => {
      expect(relayScript).toContain('usage: node relay.js');
      expect(relayScript).toContain('process.exit(1)');
    });
  });
});

// ---------------------------------------------------------------------------
// Allowlist matching (DEC-0011 ruling 2/3, WK-0104) — destinationAllowed()
// widened from a single granted target to an allowlist SET (exact hostnames
// + *.suffix wildcards): Pi's one model endpoint, a SaaS family's vendor
// domain set, or a credential profile's endpoint set, all folded into one
// ALLOWED_HOSTS array by pipeline.ts's buildAllowedHosts before spawn.
// ---------------------------------------------------------------------------

describe('allowlist matching in generated forwarder', () => {
  it('forwarder script contains matchesAllowlist function', () => {
    const config: TunnelConfig = {
      socketPath: '/tmp/test.sock',
      targetUrl: 'http://localhost:11434/v1',
      allowedHosts: ['localhost', 'api.anthropic.com'],
      webEnabled: false,
    };
    const { forwarderScript } = buildTunnelScripts(config);
    expect(forwarderScript).toContain('matchesAllowlist');
  });

  it('forwarder script parses ALLOWED_HOSTS_JSON from argv[6]', () => {
    const config: TunnelConfig = {
      socketPath: '/tmp/test.sock',
      targetUrl: 'http://localhost:11434/v1',
      allowedHosts: ['localhost'],
      webEnabled: false,
    };
    const { forwarderScript } = buildTunnelScripts(config);
    expect(forwarderScript).toContain('process.argv[6]');
    expect(forwarderScript).toContain('ALLOWED_HOSTS_JSON');
  });

  it('forwarder checks against allowlist instead of single target hostname', () => {
    const config: TunnelConfig = {
      socketPath: '/tmp/test.sock',
      targetUrl: 'http://localhost:11434/v1',
      allowedHosts: ['localhost'],
      webEnabled: false,
    };
    const { forwarderScript } = buildTunnelScripts(config);
    // Must NOT contain the old single-target check
    expect(forwarderScript).not.toContain('hostname === TARGET.hostname && port === TARGET_PORT');
    // Must contain the new allowlist check
    expect(forwarderScript).toContain('matchesAllowlist(hostname)');
  });

  it('wildcard matching supports *.suffix entries', () => {
    const config: TunnelConfig = {
      socketPath: '/tmp/test.sock',
      targetUrl: 'http://localhost:11434/v1',
      allowedHosts: ['*.amazonaws.com'],
      webEnabled: false,
    };
    const { forwarderScript } = buildTunnelScripts(config);
    expect(forwarderScript).toContain("entry.startsWith('*.')");
  });

  it('falls back to an empty (closed) allowlist on malformed ALLOWED_HOSTS_JSON, never throws', () => {
    // The forwarder script parses ALLOWED_HOSTS_JSON in a try/catch that
    // degrades to '[]' -- a parse failure must never open the destination
    // policy wide by accident (fail-closed, not fail-open).
    const config: TunnelConfig = {
      socketPath: '/tmp/test.sock',
      targetUrl: 'http://localhost:11434/v1',
      allowedHosts: ['localhost'],
      webEnabled: false,
    };
    const { forwarderScript } = buildTunnelScripts(config);
    expect(forwarderScript).toMatch(/catch\s*\{\s*return \[\];\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// buildTunnelBashLines
// ---------------------------------------------------------------------------

describe('buildTunnelBashLines', () => {
  describe('web:false', () => {
    const lines = buildTunnelBashLines(baseConfig, runDirWsl);

    it('preJailLines writes the forwarder script via a quoted heredoc', () => {
      const joined = lines.preJailLines.join('\n');
      expect(joined).toContain("cat <<'TUNNEL_FORWARDER_EOF'");
      expect(joined).toContain('TUNNEL_FORWARDER_EOF');
      expect(joined).toContain(`${runDirWsl}/forwarder.js`);
    });

    it('preJailLines writes the relay script for the jail to bind-mount', () => {
      const joined = lines.preJailLines.join('\n');
      expect(joined).toContain("cat <<'TUNNEL_RELAY_EOF'");
      expect(joined).toContain(`${runDirWsl}/relay.js`);
    });

    it('preJailLines starts the forwarder in the background and captures its PID', () => {
      const joined = lines.preJailLines.join('\n');
      expect(joined).toMatch(/node .*forwarder\.js.* &$/m);
      expect(joined).toContain('FORWARDER_PID=$!');
    });

    it('preJailLines passes web:false through to the forwarder argv', () => {
      const joined = lines.preJailLines.join('\n');
      expect(joined).toMatch(/node .*forwarder\.js[^\n]*'false'/);
    });

    it('preJailLines passes the JSON-encoded allowedHosts as a 5th forwarder argv (DEC-0011/WK-0104)', () => {
      const joined = lines.preJailLines.join('\n');
      const expectedJson = JSON.stringify(baseConfig.allowedHosts);
      expect(joined).toContain(expectedJson);
      // Ordering: socketPath, targetUrl, webEnabled, logPath, THEN allowedHostsJson.
      const forwarderLine = lines.preJailLines.find((l) => l.trim().startsWith('node ') && l.includes('forwarder.js'));
      expect(forwarderLine).toBeDefined();
      expect(forwarderLine!.indexOf(expectedJson)).toBeGreaterThan(forwarderLine!.indexOf(baseConfig.targetUrl));
    });

    it('preJailLines exports all four proxy env var casings at the relay address', () => {
      const joined = lines.preJailLines.join('\n');
      expect(joined).toContain('export HTTP_PROXY=');
      expect(joined).toContain('export HTTPS_PROXY=');
      expect(joined).toContain('export http_proxy=');
      expect(joined).toContain('export https_proxy=');
      expect(joined).toContain(`http://127.0.0.1:${TUNNEL_RELAY_PORT}`);
    });

    it('inJailPrefix brings up the loopback interface before starting the relay', () => {
      const loIndex = lines.inJailPrefix.findIndex((l) => l.includes('ip link set lo up'));
      const relayIndex = lines.inJailPrefix.findIndex((l) => l.includes('relay.js'));
      expect(loIndex).toBeGreaterThanOrEqual(0);
      expect(relayIndex).toBeGreaterThan(loIndex);
    });

    it('inJailPrefix starts the relay in the background and captures its PID', () => {
      const joined = lines.inJailPrefix.join('\n');
      expect(joined).toMatch(/node .*relay\.js.* &$/m);
      expect(joined).toContain('RELAY_PID=$!');
    });

    it('inJailSuffix kills the relay', () => {
      expect(lines.inJailSuffix.join('\n')).toContain('kill $RELAY_PID');
    });

    it('postJailLines kills and reaps the forwarder (--die-with-parent does not reach outside bwrap)', () => {
      const joined = lines.postJailLines.join('\n');
      expect(joined).toContain('kill $FORWARDER_PID');
      expect(joined).toContain('wait $FORWARDER_PID');
    });
  });

  describe('web:true', () => {
    const falseLines = buildTunnelBashLines(baseConfig, runDirWsl);
    const trueLines = buildTunnelBashLines({ ...baseConfig, webEnabled: true }, runDirWsl);

    it('passes web:true through to the forwarder argv', () => {
      expect(trueLines.preJailLines.join('\n')).toMatch(/node .*forwarder\.js[^\n]*'true'/);
    });

    it('exports the identical proxy env vars as web:false -- routing never changes, only forwarder-side policy does', () => {
      const proxyExports = (arr: string[]) => arr.filter((l) => l.startsWith('export '));
      expect(proxyExports(trueLines.preJailLines)).toEqual(proxyExports(falseLines.preJailLines));
    });

    it('leaves inJailPrefix, inJailSuffix, and postJailLines unaffected by the web flag', () => {
      expect(trueLines.inJailPrefix).toEqual(falseLines.inJailPrefix);
      expect(trueLines.inJailSuffix).toEqual(falseLines.inJailSuffix);
      expect(trueLines.postJailLines).toEqual(falseLines.postJailLines);
    });
  });

  describe('defaults and overrides', () => {
    it('defaults relayPort to TUNNEL_RELAY_PORT when omitted', () => {
      const lines = buildTunnelBashLines(baseConfig, runDirWsl);
      expect(lines.preJailLines.join('\n')).toContain(`http://127.0.0.1:${TUNNEL_RELAY_PORT}`);
      expect(lines.inJailPrefix.join('\n')).toContain(`'${TUNNEL_RELAY_PORT}'`);
    });

    it('honors a custom relayPort end to end (proxy env + relay argv)', () => {
      const lines = buildTunnelBashLines({ ...baseConfig, relayPort: 19999 }, runDirWsl);
      expect(lines.preJailLines.join('\n')).toContain('http://127.0.0.1:19999');
      expect(lines.inJailPrefix.join('\n')).toContain("'19999'");
    });

    it('defaults the destination log path under runDirWsl when logPath is omitted', () => {
      const lines = buildTunnelBashLines(baseConfig, runDirWsl);
      expect(lines.preJailLines.join('\n')).toContain(`${runDirWsl}/tunnel-destinations.log`);
    });

    it('honors a custom logPath when provided', () => {
      const lines = buildTunnelBashLines({ ...baseConfig, logPath: '/custom/dest.log' }, runDirWsl);
      const joined = lines.preJailLines.join('\n');
      expect(joined).toContain('/custom/dest.log');
      expect(joined).not.toContain(`${runDirWsl}/tunnel-destinations.log`);
    });
  });

  it('is pure -- identical inputs produce identical output', () => {
    const a = buildTunnelBashLines(baseConfig, runDirWsl);
    const b = buildTunnelBashLines({ ...baseConfig }, runDirWsl);
    expect(a).toEqual(b);
  });

  it('quotes values containing a single quote safely for shell embedding', () => {
    const configWithQuote: TunnelConfig = {
      ...baseConfig,
      socketPath: "/mnt/c/Users/o'brien/run/tunnel.sock",
    };
    const joined = buildTunnelBashLines(configWithQuote, runDirWsl).preJailLines.join('\n');
    // shQuote's escaping for an embedded single quote is close-quote,
    // escaped-quote, reopen-quote ( '\'' ) -- the raw value is never
    // interpolated as a naive, unescaped 'o'brien' (which would prematurely
    // close the shell string); the properly-escaped form splits it into
    // o + '\'' + brien instead.
    expect(joined).toContain("o'\\''brien");
    expect(joined).not.toContain("'/mnt/c/Users/o'brien/run/tunnel.sock'");
  });

  it('never emits an unquoted-looking socketPath/targetUrl in the forwarder invocation', () => {
    const lines = buildTunnelBashLines(baseConfig, runDirWsl);
    const forwarderInvocation = lines.preJailLines.find((l) => l.trim().startsWith('node ') && l.includes('forwarder.js'));
    expect(forwarderInvocation).toBeDefined();
    expect(forwarderInvocation).toContain(`'${baseConfig.socketPath}'`);
    expect(forwarderInvocation).toContain(`'${baseConfig.targetUrl}'`);
  });
});

// ---------------------------------------------------------------------------
// DEC-0011 per-family forwarder policy assertions
// ---------------------------------------------------------------------------

describe('DEC-0011 per-family forwarder policy assertions', () => {
  it('unshareNet is true for all families — no family-conditional bypass', () => {
    // Structural assertion on the ONE call site that decides this: pipeline.ts
    // passes a single unconditional `unshareNet: true` into buildBwrapPlan for
    // every family (pi/codex/claude alike) -- there is no per-family ternary
    // or bypass anywhere in the pipeline. buildJailArgs/buildBwrapPlan's own
    // --unshare-net threading (opts.unshareNet -> '--unshare-net' argv) is
    // already covered by dispatch-v2-jail.test.ts's "unshareNet:true adds
    // --unshare-net..." -- that proves the plumbing works, not that pipeline.ts
    // actually calls it with `true` for all families, which is what this test
    // guards (DEC-0011 ruling 3 / WK-0104 AC 1: "no family-conditional bypass
    // of the network namespace exists anywhere in the pipeline").
    const pipelineSrc = readFileSync(join(process.cwd(), 'packages', 'dispatch-core', 'src', 'pipeline.ts'), 'utf8');
    expect(pipelineSrc).toContain('unshareNet: true,');
    expect(pipelineSrc).not.toMatch(/unshareNet:\s*(model\.family|family\s*===|handoff\.web|opts\.web)/);
  });
});

// ---------------------------------------------------------------------------
// WK-0266 ruling 8 — provenance.json retired; the forwarder's argv and the
// provider-usage tap replace it. buildTunnelScripts()/buildTunnelBashLines()
// script-text assertions only (the real tap's byte-level behavior is covered
// by dispatch-v2-tunnel-integration.test.ts's real-process tests).
// ---------------------------------------------------------------------------

describe('WK-0266 ruling 8 — provenance.json retired from the generated forwarder', () => {
  it('the generated forwarder never references provenance.json / PROVENANCE_PATH / writeProvenance', () => {
    const { forwarderScript } = buildTunnelScripts(baseConfig);
    expect(forwarderScript).not.toMatch(/provenance/i);
  });

  it('argv[7] is named/documented as the provider-usage path, not a provenance path', () => {
    const { forwarderScript } = buildTunnelScripts(baseConfig);
    expect(forwarderScript).toContain('PROVIDER_USAGE_PATH = process.argv[7]');
    expect(forwarderScript).toContain('providerUsagePath');
  });

  it('buildTunnelBashLines keeps its own forwarder invocation argv unchanged (allowedHostsJson is still the LAST quoted arg -- no 6th provider-usage path appended) — ruling 8', () => {
    const lines = buildTunnelBashLines(baseConfig, runDirWsl);
    const forwarderLine = lines.preJailLines.find((l) => l.trim().startsWith('node ') && l.includes('forwarder.js'));
    expect(forwarderLine).toBeDefined();
    const expectedAllowedHostsJson = `'${JSON.stringify(baseConfig.allowedHosts)}'`; // mirrors tunnel.ts's private shQuote (no special chars in this fixture)
    const beforeRedirect = forwarderLine!.split('<')[0];
    expect(beforeRedirect.trim().endsWith(expectedAllowedHostsJson)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WK-0266 ruling 1/2 — the generated forwarder's provider-usage tap (script
// text only; real byte-level/process behavior is
// dispatch-v2-tunnel-integration.test.ts's job).
// ---------------------------------------------------------------------------

describe('WK-0266 ruling 1/2 — provider-usage tap generated into the forwarder script', () => {
  const { forwarderScript } = buildTunnelScripts(baseConfig);

  it('never calls setEncoding on the upstream response (ruling 2: the tap must not change the relayed stream)', () => {
    // Comments ABOUT not calling it are fine; only an actual call (a
    // `.setEncoding(` invocation) would change what every listener,
    // including the relay pipe, receives.
    expect(forwarderScript).not.toMatch(/\.setEncoding\(/);
  });

  it('still pipes the upstream response to the client unmodified (the tap listens NEXT TO the pipe, not instead of it)', () => {
    expect(forwarderScript).toContain('upstreamRes.pipe(res)');
  });

  it('adds its own data listener alongside the pipe, decoding its own copy with a persistent TextDecoder (survives a multibyte split across chunks)', () => {
    expect(forwarderScript).toContain("upstreamRes.on('data', (chunk) => feedUsageTap(usageRecord, chunk))");
    expect(forwarderScript).toContain('new TextDecoder(');
    expect(forwarderScript).toContain("decode(chunk, { stream: true })");
  });

  it('caps the pending partial line at 1 MiB and counts an over-long line as dropped rather than growing without bound', () => {
    expect(forwarderScript).toContain('MAX_PENDING_LINE_BYTES = 1024 * 1024');
    expect(forwarderScript).toContain('dropped_lines += 1');
  });

  it('skips SSE comment lines (":" prefix) and "data: [DONE]"', () => {
    expect(forwarderScript).toContain("line.charAt(0) === ':'");
    expect(forwarderScript).toContain("payload === '[DONE]'");
  });

  it('counts a JSON parse failure on a data line rather than throwing', () => {
    expect(forwarderScript).toMatch(/catch \(err\) \{\s*record\.parse_errors \+= 1;/);
  });

  it('records distinct providers in first-seen order and the x-inference-provider header as a fallback field', () => {
    expect(forwarderScript).toContain('record.providers.indexOf(parsed.provider) === -1');
    expect(forwarderScript).toContain("headers['x-inference-provider']");
  });

  it('writes exactly one record per response (a one-shot guard) and forces cost:null whenever ended is false', () => {
    expect(forwarderScript).toContain('if (record.recorded) return;');
    expect(forwarderScript).toContain('if (!ended) record.cost = null;');
  });

  it('flushes every still-open response on SIGTERM before exiting (ruling 3)', () => {
    expect(forwarderScript).toContain("process.on('SIGTERM'");
    expect(forwarderScript).toMatch(/for \(const record of Array\.from\(openUsageRecords\)\)/);
    expect(forwarderScript).toContain('process.exit(0)');
  });

  it('appends to the provider-usage file with fs.appendFileSync (never buffers records in memory for a later single write)', () => {
    expect(forwarderScript).toContain('fs.appendFileSync(PROVIDER_USAGE_PATH, line)');
  });

  it('a write failure is caught, never thrown (rule 24: counted/logged, not swallowed into a crash)', () => {
    expect(forwarderScript).toMatch(/fs\.appendFileSync\(PROVIDER_USAGE_PATH, line\);\s*\} catch \(err\) \{/);
  });
});

// ---------------------------------------------------------------------------
// WK-0266 golden fixtures — copied unedited from the read-only data mount
// (tests/fixtures/openrouter-sse/). A hand edit to any of the 5 copied
// stream_*.sse files fails this test; SHA256SUMS itself is copied whole and
// unedited, but only the 5 copied files' lines are checked here (its other
// listed files were never copied — rule 33).
// ---------------------------------------------------------------------------

describe('WK-0266 golden fixtures (tests/fixtures/openrouter-sse/) match SHA256SUMS', () => {
  const fixturesDir = join(process.cwd(), 'tests', 'fixtures', 'openrouter-sse');
  const copiedFiles = [
    'stream_morph.sse',
    'stream_openai.sse',
    'stream_openai_reasoning.sse',
    'stream_parasail.sse',
    'stream_parasail_utf8.sse',
  ];

  it('SHA256SUMS is present, copied whole and unedited', () => {
    expect(existsSync(join(fixturesDir, 'SHA256SUMS'))).toBe(true);
  });

  it.each(copiedFiles)('%s sha256 matches its SHA256SUMS line', (filename) => {
    const sums = readFileSync(join(fixturesDir, 'SHA256SUMS'), 'utf8');
    const line = sums.split('\n').find((l) => l.trim().endsWith(filename));
    expect(line, `no SHA256SUMS line for ${filename}`).toBeDefined();
    const expectedHash = line!.trim().split(/\s+/)[0];

    const actualHash = createHash('sha256').update(readFileSync(join(fixturesDir, filename))).digest('hex');
    expect(actualHash).toBe(expectedHash);
  });

  it('a hand edit to a copied fixture fails the hash check (bite proof)', () => {
    const real = readFileSync(join(fixturesDir, 'stream_morph.sse'));
    const tampered = Buffer.concat([real, Buffer.from('\n')]);
    const sums = readFileSync(join(fixturesDir, 'SHA256SUMS'), 'utf8');
    const line = sums.split('\n').find((l) => l.trim().endsWith('stream_morph.sse'));
    const expectedHash = line!.trim().split(/\s+/)[0];
    const tamperedHash = createHash('sha256').update(tampered).digest('hex');
    expect(tamperedHash).not.toBe(expectedHash);
  });
});
