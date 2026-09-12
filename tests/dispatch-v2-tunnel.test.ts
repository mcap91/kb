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
