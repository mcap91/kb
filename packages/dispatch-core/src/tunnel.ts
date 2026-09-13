/**
 * Network egress tunnel — code generation only (T26 S5; spec §11 D21;
 * execution/s5-rulings.md ruling 1, operator-ratified).
 *
 * A jailed worker runs `--unshare-net` (S5 full jail recipe, T15 — not this
 * file): the jail has no network stack at all. Two Node.js processes bridge a
 * single path back out, both generated here as plain strings:
 *
 *   - The FORWARDER runs OUTSIDE bwrap, in WSL2 — it is the process that
 *     actually owns a network interface. It listens on a unix domain socket
 *     staged under the run dir (ext4) and relays HTTP traffic onward: on
 *     `web:false` ONLY to the run's one granted inference endpoint (every
 *     other destination is refused and logged); on `web:true` to anywhere
 *     (ruling 4 — the flag itself is the grant). TLS to an `https://` target
 *     originates AT the forwarder; the hop across the socket is always plain
 *     HTTP — kernel-local memory, never a wire.
 *   - The RELAY runs INSIDE bwrap, inside the `--unshare-net` namespace. It is
 *     a dumb TCP<->unix-socket byte shovel on a fixed loopback port (no
 *     HTTP awareness at all), so Pi's plain HTTP client has something to dial
 *     even though the jail itself cannot open a real network socket.
 *
 * Both scripts are self-contained (Node.js built-ins only — `node:http`,
 * `node:https`, `node:net`, `node:fs`, `node:url` — no npm packages) and
 * argv-driven: the values baked in at generation time are the defaults only
 * (e.g. the relay's fallback port); the actual socket path / target URL /
 * web flag / log path are passed as CLI arguments by the bash lines below, so
 * the SAME generated script text works for both `web:true` and `web:false`
 * runs — only the argv differs (this is why `buildTunnelBashLines`'s own test
 * coverage checks that the proxy env vars are identical across the flag:
 * routing never changes, only the policy the forwarder enforces at runtime).
 *
 * Routing (pipeline.ts's job, not this module's — W2): dispatch rewrites the
 * per-worker `models.json` `baseUrl` to `http://127.0.0.1:<relayPort>` at
 * generation time (Node's fetch/undici ignores `HTTP_PROXY` by default, so
 * this rewrite is the routing mechanism that actually works for Pi). The
 * `HTTP_PROXY`/`HTTPS_PROXY`/lowercase variants exported below point at the
 * same address for bash tools (curl/wget honor them).
 *
 * This module never starts a process, opens a socket, or touches the
 * filesystem itself — it only assembles strings. Nothing here can fail, so
 * nothing here returns a `DispatchResult`.
 */

export interface TunnelConfig {
  /** Unix socket path on ext4 (under run dir) */
  socketPath: string;
  /** The real inference endpoint URL (e.g. 'http://172.26.0.1:11434/v1' or 'https://openrouter.ai/api/v1') */
  targetUrl: string;
  /** web:true = open egress; web:false = single destination */
  webEnabled: boolean;
  /** In-jail relay port (default 18787) */
  relayPort?: number;
  /** Path for destination log */
  logPath?: string;
}

export interface TunnelScripts {
  /** Self-contained Node.js forwarder script content */
  forwarderScript: string;
  /** Self-contained Node.js relay script content */
  relayScript: string;
}

export interface TunnelBashLines {
  /** Lines to add BEFORE bwrap in the execution script (start forwarder, export proxy env) */
  preJailLines: string[];
  /** Lines to run INSIDE bwrap before the worker (bring up lo, start relay, wait) */
  inJailPrefix: string[];
  /** Lines to run INSIDE bwrap after the worker (kill relay) */
  inJailSuffix: string[];
  /** Lines to add AFTER bwrap in the execution script (kill forwarder) */
  postJailLines: string[];
}

/** Default in-jail relay port — fixed, since it lives inside its own `--unshare-net` namespace and can never collide with anything else. */
export const TUNNEL_RELAY_PORT = 18787;

/** Socket filename convention, staged under the run dir on ext4. */
export const TUNNEL_SOCKET_NAME = 'tunnel.sock';

/** Single-quote a value for safe embedding in generated bash (mirrors pipeline.ts's / credentials.ts's private helper). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Generate the two self-contained Node.js scripts (host-side forwarder,
 * in-jail relay). Both are plain CommonJS `.js` text (no imports from this
 * package, no npm packages) so they run standalone via a bare `node
 * <file>.js <args>` — no TS toolchain, no `package.json`, no `node_modules`
 * needed wherever they land. Pure and synchronous: this only builds strings.
 *
 * The scripts themselves parse their configuration from `process.argv` at
 * spawn time (see `buildTunnelBashLines`) rather than baking `config` into
 * the generated text — `config.relayPort` is used only as the relay's
 * fallback default (belt-and-suspenders; the bash lines always pass it
 * explicitly too).
 */
export function buildTunnelScripts(config: TunnelConfig): TunnelScripts {
  const defaultRelayPort = config.relayPort ?? TUNNEL_RELAY_PORT;

  const forwarderScript = `'use strict';

// Dispatch network-egress tunnel — HOST-SIDE FORWARDER. Runs OUTSIDE bwrap,
// in WSL2 (PLN-0004 S5 T26; spec S11 D21; execution/s5-rulings.md ruling 1).
//
// Bridges a unix domain socket to the run's granted inference endpoint (or,
// on web:true, to any destination). The in-jail relay bridges
// 127.0.0.1:<port> inside its own network namespace to this same socket via
// a bind mount, so this forwarder is the only process in the whole run that
// ever touches a real network interface for egress.
//
// Self-contained: Node.js built-ins only, no npm packages.
// Usage: node forwarder.js <socketPath> <targetUrl> <webEnabled:true|false> <logPath>

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const { URL } = require('node:url');

const SOCKET_PATH = process.argv[2];
const TARGET_URL = process.argv[3];
const WEB_ENABLED_ARG = process.argv[4];
const LOG_PATH = process.argv[5];

if (!SOCKET_PATH || !TARGET_URL || !WEB_ENABLED_ARG || !LOG_PATH) {
  console.error('usage: node forwarder.js <socketPath> <targetUrl> <webEnabled:true|false> <logPath>');
  process.exit(1);
}

const WEB_ENABLED = WEB_ENABLED_ARG === 'true';
const TARGET = new URL(TARGET_URL);
const TARGET_IS_TLS = TARGET.protocol === 'https:';
const TARGET_PORT = Number(TARGET.port) || (TARGET_IS_TLS ? 443 : 80);

// Every attempted destination is logged, allowed or not — redteam forensics
// (execution/s5-rulings.md ruling 1): timestamp, method, destination, verdict.
function logDestination(method, destination, allowed) {
  const line = new Date().toISOString() + ' ' + method + ' ' + destination + ' ' + (allowed ? 'allowed' : 'denied') + '\\n';
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (err) {
    // Best-effort logging only — never block a request on a logging failure.
  }
}

// web:false — single destination (the granted inference endpoint) only.
// web:true — open egress (ruling 4): the flag itself is the grant.
function destinationAllowed(hostname, port) {
  if (WEB_ENABLED) return true;
  return hostname === TARGET.hostname && port === TARGET_PORT;
}

// Plain HTTP: handles an absolute-URI request line (a bash tool under
// HTTP_PROXY naming a real destination) and a plain origin-form request (no
// third-party destination named at all — Pi's baseUrl points straight at
// this forwarder, so an origin-form request always means the one granted
// inference endpoint).
const server = http.createServer((req, res) => {
  const url = req.url || '';
  const isAbsolute = url.startsWith('http://') || url.startsWith('https://');
  let destHostname;
  let destPort;
  let destPath;
  let destIsTls;

  if (isAbsolute) {
    const parsed = new URL(url);
    destHostname = parsed.hostname;
    destIsTls = parsed.protocol === 'https:';
    destPort = Number(parsed.port) || (destIsTls ? 443 : 80);
    destPath = parsed.pathname + parsed.search;
  } else {
    destHostname = TARGET.hostname;
    destIsTls = TARGET_IS_TLS;
    destPort = TARGET_PORT;
    destPath = url || '/';
  }

  const allowed = destinationAllowed(destHostname, destPort);
  const destDisplay = (destIsTls ? 'https://' : 'http://') + destHostname + ':' + destPort + destPath;
  logDestination(req.method || 'GET', destDisplay, allowed);

  if (!allowed) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('tunnel: destination not allowed (web:false)');
    return;
  }

  // TLS originates HERE when the real endpoint is HTTPS — the in-jail hop is
  // always plain HTTP over the unix socket, never a wire.
  const transport = destIsTls ? https : http;
  const outHeaders = Object.assign({}, req.headers);
  delete outHeaders['proxy-connection'];
  outHeaders.host = destPort === (destIsTls ? 443 : 80) ? destHostname : destHostname + ':' + destPort;

  const upstreamReq = transport.request(
    {
      hostname: destHostname,
      port: destPort,
      method: req.method,
      path: destPath,
      headers: outHeaders,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      // Pipe, never buffer — model responses stream via SSE; a buffering
      // proxy (e.g. collecting the body before responding) breaks Pi silently.
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('tunnel: upstream request failed: ' + err.message);
  });

  // Pipe the request body upstream too — never buffer it either.
  req.pipe(upstreamReq);
});

// CONNECT tunneling — bash tools under HTTPS_PROXY (web:true) or an HTTPS
// call straight at the granted endpoint's own host:port.
server.on('connect', (req, clientSocket, head) => {
  const target = req.url || '';
  const sepIndex = target.lastIndexOf(':');
  const hostname = sepIndex === -1 ? target : target.slice(0, sepIndex);
  const port = Number(sepIndex === -1 ? '443' : target.slice(sepIndex + 1)) || 443;
  const allowed = destinationAllowed(hostname, port);

  logDestination('CONNECT', hostname + ':' + port, allowed);

  if (!allowed) {
    clientSocket.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
    return;
  }

  const upstreamSocket = net.connect(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head && head.length) upstreamSocket.write(head);
    // Bidirectional pipe — no buffering, so the TLS handshake and everything
    // after it passes through untouched, end to end between the client and
    // the real destination.
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', () => {
    clientSocket.destroy();
  });
  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
});

server.on('error', (err) => {
  console.error('tunnel forwarder error: ' + err.message);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
  }
});

// A stale socket file left over from a prior run fails EADDRINUSE on
// listen() even though nothing is actually listening any more — clear it
// first (ENOENT here just means there was no stale socket, which is fine).
try {
  fs.unlinkSync(SOCKET_PATH);
} catch (err) {
  // ignore — no stale socket to remove
}

server.listen(SOCKET_PATH, () => {
  console.log('tunnel forwarder listening on ' + SOCKET_PATH + ' -> ' + TARGET_URL + ' (web:' + WEB_ENABLED + ')');
});
`;

  const relayScript = `'use strict';

// Dispatch network-egress tunnel — IN-JAIL RELAY. Runs INSIDE bwrap, inside
// the --unshare-net network namespace (PLN-0004 S5 T26; spec S11 D21;
// execution/s5-rulings.md ruling 1).
//
// A fresh network namespace starts with lo DOWN — the run script brings it
// up ("ip link set lo up") before this relay ever binds (known wrinkle,
// execution/s5-rulings.md). TCP listener on 127.0.0.1:<port> shovels bytes
// bidirectionally into the bind-mounted unix socket that bridges out to the
// host-side forwarder. No HTTP awareness at all here — a pure byte pipe, so
// it never buffers and never breaks SSE.
//
// Self-contained: Node.js built-ins only, no npm packages.
// Usage: node relay.js <relayPort> <socketPath>

const net = require('node:net');

const PORT_ARG = process.argv[2];
const SOCKET_PATH = process.argv[3];

if (!PORT_ARG || !SOCKET_PATH) {
  console.error('usage: node relay.js <relayPort> <socketPath>');
  process.exit(1);
}

const PORT = Number(PORT_ARG) || ${defaultRelayPort};

const server = net.createServer((clientSocket) => {
  const upstream = net.connect(SOCKET_PATH);

  const closeBoth = () => {
    clientSocket.destroy();
    upstream.destroy();
  };

  upstream.on('connect', () => {
    // Pure bidirectional byte shovel — pipe, never buffer, so SSE and any
    // other streamed protocol riding over this socket passes through
    // untouched.
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  clientSocket.on('error', closeBoth);
  upstream.on('error', closeBoth);
  clientSocket.on('close', closeBoth);
  upstream.on('close', closeBoth);
});

server.on('error', (err) => {
  console.error('tunnel relay error: ' + err.message);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('tunnel relay listening on 127.0.0.1:' + PORT + ' -> ' + SOCKET_PATH);
});
`;

  return { forwarderScript, relayScript };
}

/**
 * Generate the bash line groups pipeline.ts (W2) splices into the execution
 * script around the bwrap invocation. Pure and synchronous — string assembly
 * only, never spawns anything.
 *
 * Path convention: the forwarder/relay script files and the destination log
 * are all written under `runDirWsl` (the same run directory pipeline.ts
 * already uses for `prompt.txt` / `pi-output.log`, e.g. via
 * `windowsToWslPath(runDir)`); `config.socketPath` is expected to already be
 * a full path under the same run dir (e.g. `` `${runDirWsl}/tunnel.sock` ``
 * via `TUNNEL_SOCKET_NAME`) — this function uses it as given rather than
 * constructing it. `inJailPrefix`/`inJailSuffix` reference those same
 * absolute paths on the assumption that the caller bind-mounts the run dir
 * (or at least the relay script + socket) onto itself inside the jail — the
 * established bwrap convention already used for the clone path (jail.ts).
 *
 * Background-process hygiene: both the forwarder and the relay are started
 * with `< /dev/null` and their own stdout/stderr redirected away from the
 * script's own descriptors. Without this, a backgrounded process that
 * inherits the parent script's stdout keeps that pipe open after the
 * foreground command exits, which can hang whatever is reading the overall
 * script's output (`execViaWsl2` capturing the whole run). The forwarder
 * (outside the jail, plain WSL2 filesystem) logs to a real file under
 * `runDirWsl` for debugging; the relay (inside the jail, where write access
 * to a bind-mounted path is not guaranteed) redirects to `/dev/null`, which
 * WK-0086's `--dev /dev` jail mount guarantees exists.
 */
export function buildTunnelBashLines(config: TunnelConfig, runDirWsl: string): TunnelBashLines {
  const relayPort = config.relayPort ?? TUNNEL_RELAY_PORT;
  const logPath = config.logPath ?? `${runDirWsl}/tunnel-destinations.log`;
  const forwarderScriptPath = `${runDirWsl}/forwarder.js`;
  const relayScriptPath = `${runDirWsl}/relay.js`;
  const forwarderLogPath = `${runDirWsl}/forwarder.log`;
  const { forwarderScript, relayScript } = buildTunnelScripts(config);
  const webEnabledArg = config.webEnabled ? 'true' : 'false';
  const proxyUrl = `http://127.0.0.1:${relayPort}`;

  const preJailLines: string[] = [
    '# --- Network egress tunnel: host-side forwarder (T26; spec S11 D21) ---',
    `cat <<'TUNNEL_FORWARDER_EOF' > ${shQuote(forwarderScriptPath)}`,
    forwarderScript,
    'TUNNEL_FORWARDER_EOF',
    '',
    `cat <<'TUNNEL_RELAY_EOF' > ${shQuote(relayScriptPath)}`,
    relayScript,
    'TUNNEL_RELAY_EOF',
    '',
    `node ${shQuote(forwarderScriptPath)} ${shQuote(config.socketPath)} ${shQuote(config.targetUrl)} ${shQuote(webEnabledArg)} ${shQuote(logPath)} < /dev/null > ${shQuote(forwarderLogPath)} 2>&1 &`,
    'FORWARDER_PID=$!',
    '# brief sleep so the forwarder is bound before the jail (and its relay) starts',
    'sleep 0.3',
    '',
    `export HTTP_PROXY=${shQuote(proxyUrl)}`,
    `export HTTPS_PROXY=${shQuote(proxyUrl)}`,
    `export http_proxy=${shQuote(proxyUrl)}`,
    `export https_proxy=${shQuote(proxyUrl)}`,
  ];

  const inJailPrefix: string[] = [
    '# --- Network egress tunnel: in-jail relay (T26; spec S11 D21) ---',
    '# a fresh network namespace starts with lo DOWN -- bring it up before the relay binds',
    'ip link set lo up 2>/dev/null || true',
    `node ${shQuote(relayScriptPath)} ${shQuote(String(relayPort))} ${shQuote(config.socketPath)} < /dev/null > /dev/null 2>&1 &`,
    'RELAY_PID=$!',
    'sleep 0.2',
  ];

  const inJailSuffix: string[] = [
    '# --- Network egress tunnel: stop the in-jail relay ---',
    'kill $RELAY_PID 2>/dev/null || true',
  ];

  const postJailLines: string[] = [
    '# --- Network egress tunnel: stop the host-side forwarder (outside bwrap; --die-with-parent does not reach it) ---',
    'kill $FORWARDER_PID 2>/dev/null || true',
    'wait $FORWARDER_PID 2>/dev/null || true',
  ];

  return { preJailLines, inJailPrefix, inJailSuffix, postJailLines };
}
