/**
 * Worker environment deny-list (D6 component 9; mid_project_review_rulings.md
 * ruling 7 component table + ruling 7 V2 correction). Design-mirrored from
 * agent-chassis's `applyBwrapEnvPolicy` — ELv2: mirrored design, TypeScript
 * written from scratch, no copied code. Chassis source:
 * `launch-isolation-env-policy.mjs:84-144` (deny-list filter over three
 * classes of denied var: secret-shaped, posture, behavior-affecting — verified
 * against the checkout, not the prior two-class assumption).
 *
 * kb-specific caveat (ruling 7 V2): kb's own tunnel (tunnel.ts:397-402)
 * deliberately SETS `HTTP_PROXY`/`HTTPS_PROXY` (plus lowercase variants) to
 * point workers at the in-jail relay. Those are exactly the vars the
 * behavior-affecting class below denies — by design. This module only
 * computes the FILTERED INHERITED env; every inherited proxy var is dropped
 * unconditionally. The caller (the spawn wrapper that starts the tunnel) adds
 * kb's own proxy vars back on top of this function's output — never the other
 * way around, or an operator's ambient `HTTP_PROXY` could silently survive
 * into the jail alongside (or instead of) kb's relay address.
 */

/** Secret-shaped: name-shape patterns, matched case-insensitively against the whole key. */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)TOKENS?($|_)/i,
  /(^|_)SECRETS?($|_)/i,
  /(^|_)PASSWORDS?($|_)/i,
  /(^|_)PASSWD($|_)/i,
  /(^|_)API_?KEY($|_)/i,
  /(^|_)ACCESS_?KEY($|_)/i,
  /(^|_)PRIVATE_?KEY($|_)/i,
  /(^|_)CREDENTIALS?($|_)/i,
  /(^|_)KEY($|_)/i,
];

/** Secret-shaped: well-known vendor/cloud names, kept explicit as a floor under the patterns above. */
const SECRET_EXACT_NAMES: ReadonlySet<string> = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
]);

/** Posture: reveals or steers dev/CI/prod runtime posture rather than holding a secret. */
const POSTURE_EXACT_NAMES: ReadonlySet<string> = new Set(['NODE_ENV', 'CI']);

/**
 * Behavior-affecting: changes how the worker's own tools run rather than what
 * they can see. Includes every proxy var kb's own tunnel later sets (see
 * module docstring) — dropped here unconditionally on the way in.
 */
const BEHAVIOR_EXACT_NAMES: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

function isSecretShaped(key: string): boolean {
  if (SECRET_EXACT_NAMES.has(key)) return true;
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(key));
}

function isDenied(key: string): boolean {
  return isSecretShaped(key) || POSTURE_EXACT_NAMES.has(key) || BEHAVIOR_EXACT_NAMES.has(key);
}

/**
 * Build the env a spawned worker should inherit from the orchestrator: start
 * from `inheritEnv` (defaults to `process.env`), drop every denied var
 * (secret-shaped / posture / behavior-affecting — see module docstring) and
 * every unset value, keep the survivors. Returns the filtered env only — it
 * never adds anything. Callers layer kb's own worker-specific vars (tunnel
 * proxy vars, credential injections) on top of this function's output.
 */
export function buildWorkerEnv(opts: { inheritEnv?: Record<string, string | undefined> }): Record<string, string> {
  const source = opts.inheritEnv ?? process.env;
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isDenied(key)) continue;
    out[key] = value;
  }

  return out;
}
