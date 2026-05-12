import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type {
  AgentLauncherConfig,
  LaunchOpts,
  RunResult,
} from './types.js';
import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import { readTokenFile, verifyToken, moveToken } from './token.js';
import { getReviewDir, getRunDir } from './paths.js';
import { loadRegistry, resolveAgentConfig } from './registry.js';
import { buildSpawnInvocation } from './spawn.js';

const ENV_ALLOWLIST_POSIX = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
];

const ENV_ALLOWLIST_WINDOWS = [
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
];

const HEARTBEAT_INTERVAL_MS = 1000;
const CANCEL_GRACE_MS = 30_000;

type LaunchTokenState = 'launching' | 'consumed' | 'rejected';
type TerminalRunStatus = 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'rejected';

type ReviewManifest = {
  handoff_id: string;
  mode: RunResult['mode'];
  wrapper: { path: string; sha256: string };
  handoff_snapshot: { path: string; sha256: string };
  context_files: Array<{ snapshot_path: string; sha256: string }>;
};

type ReviewMetadata = {
  review_id: string;
  handoff_id: string;
  agent: string;
  mode: RunResult['mode'];
  repo_root: string;
  input_manifest_hash: string;
  registry_hash: string;
  expires_at: string;
};

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sha256Tagged(data: string | Buffer): string {
  return `sha256:${sha256(data)}`;
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function sha256TaggedFile(path: string): Promise<string> {
  return sha256Tagged(await readFile(path));
}

async function writeAtomic(targetPath: string, content: string): Promise<void> {
  const dirPath = dirname(targetPath);
  await mkdir(dirPath, { recursive: true });
  const tempPath = join(
    dirPath,
    `.tmp-${basename(targetPath)}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, targetPath);
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await writeAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyTree(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath);
    } else {
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function replacePlaceholders(value: string, replacements: Record<string, string>): string {
  return value
    .replaceAll('{repo_root}', replacements.repo_root)
    .replaceAll('{wrapper_path}', replacements.wrapper_path)
    .replaceAll('{wrapper_content}', replacements.wrapper_content)
    .replaceAll('{response_path}', replacements.response_path);
}

function buildEnv(
  repoRoot: string,
  runDir: string,
  agentVisibleDir: string,
  handoffPath: string,
  contextDir: string,
  responsePath: string,
  reviewId: string,
  runId: string,
  launcherEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowlist = [...ENV_ALLOWLIST_POSIX];
  if (process.platform === 'win32') {
    allowlist.push(...ENV_ALLOWLIST_WINDOWS);
  }

  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (launcherEnv) {
    Object.assign(env, launcherEnv);
  }

  env['AGENT_BLACKBOARD_REPO_ROOT'] = repoRoot;
  env['AGENT_BLACKBOARD_RUN_DIR'] = runDir;
  env['AGENT_BLACKBOARD_AGENT_VISIBLE_DIR'] = agentVisibleDir;
  env['AGENT_BLACKBOARD_HANDOFF_PATH'] = handoffPath;
  env['AGENT_BLACKBOARD_CONTEXT_DIR'] = contextDir;
  env['AGENT_BLACKBOARD_RESPONSE_PATH'] = responsePath;
  env['AGENT_BLACKBOARD_REVIEW_ID'] = reviewId;
  env['AGENT_BLACKBOARD_RUN_ID'] = runId;
  return env;
}

function buildCommand(
  agent: AgentLauncherConfig,
  mode: RunResult['mode'],
  wrapperContent: string,
  wrapperPath: string,
  responsePath: string,
  repoRoot: string,
): { command: string; args: string[] } {
  const replacements = {
    repo_root: repoRoot,
    wrapper_path: wrapperPath,
    wrapper_content: wrapperContent,
    response_path: responsePath,
  };

  const command = agent.base_argv[0]!;
  const args = [
    ...agent.base_argv.slice(1),
    ...agent.noninteractive_argv,
  ];

  if (agent.instruction_transport.kind !== 'stdin' && agent.wrapper_arg) {
    for (const value of agent.wrapper_arg) {
      args.push(replacePlaceholders(value, replacements));
    }
  }

  if (agent.response_transport.kind === 'file' && agent.response_arg) {
    for (const value of agent.response_arg) {
      args.push(replacePlaceholders(value, replacements));
    }
  }

  if (mode === 'redteam' && agent.read_only?.argv_suffix) {
    args.push(...agent.read_only.argv_suffix);
  }

  return { command, args };
}

async function writeLaunchMetadata(
  metadataDir: string,
  data: {
    reviewId: string;
    runId: string;
    tokenState: LaunchTokenState;
    startedAt: string;
    completedAt?: string;
    exitCode?: number;
    error?: string;
    responsePath?: string | null;
    stdoutPath?: string | null;
    stderrPath?: string | null;
  },
): Promise<void> {
  const payload = {
    schema_version: 1,
    review_id: data.reviewId,
    run_id: data.runId,
    token_state: data.tokenState,
    started_at: data.startedAt,
    ...(data.completedAt !== undefined ? { completed_at: data.completedAt } : {}),
    ...(data.exitCode !== undefined ? { exit_code: data.exitCode } : {}),
    ...(data.error !== undefined ? { error: data.error } : {}),
    ...(data.responsePath !== undefined ? { response_path: data.responsePath } : {}),
    ...(data.stdoutPath !== undefined ? { stdout_path: data.stdoutPath } : {}),
    ...(data.stderrPath !== undefined ? { stderr_path: data.stderrPath } : {}),
  };

  await writeJsonAtomic(join(metadataDir, 'launch.json'), payload);
}

async function writeStateMetadata(
  metadataDir: string,
  data: {
    runId: string;
    status: 'launching' | TerminalRunStatus;
    pid: number;
    pgid: number;
    startedAt: string;
    heartbeatAt: string;
  },
): Promise<void> {
  await writeJsonAtomic(
    join(metadataDir, 'state.json'),
    {
      schema_version: 1,
      run_id: data.runId,
      status: data.status,
      pid: data.pid,
      pgid: data.pgid,
      started_at: data.startedAt,
      heartbeat_at: data.heartbeatAt,
    },
  );
}

function buildEmptyBodyDiagnostic(transportKind: AgentLauncherConfig['response_transport']['kind']): string {
  const transportLabel = transportKind === 'stdout_capture'
    ? 'captured nothing on child stdout'
    : 'received no bytes in the launcher-owned response file';
  return [
    '# Launcher diagnostic',
    '',
    'The adapter exited without producing a response body.',
    `The launcher ${transportLabel} and is failing closed rather than reporting a silent completed run.`,
    '',
    'Likely causes:',
    '- the adapter\'s non-interactive mode suppresses the final answer (for example, Claude Code with `--permission-mode plan` submits its plan through a tool call that is not streamed to stdout in `--output-format text`)',
    '- the adapter crashed after opening the response target without writing to it',
    '- the selected wrapper/mode combination caused the model to terminate with only tool-call output',
    '',
    'Inspect `metadata/stderr.log` and `metadata/stdout.log` (when present) to diagnose.',
    '',
  ].join('\n');
}

function stripLeadingFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function normalizeResponseContent(content: string, frontmatter: Record<string, string | number>): string {
  const stripped = stripLeadingFrontmatter(content);
  const header = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    header.push(`${key}: ${value}`);
  }
  header.push('---', '', stripped.trimStart());
  return `${header.join('\n').trimEnd()}\n`;
}

function sanitizeAbsoluteArg(value: string, placeholders: Array<[string, string]>): string {
  for (const [actual, token] of placeholders) {
    if (value === actual) {
      return token;
    }
  }
  if (isAbsolute(value)) {
    return '<abs_path>';
  }
  return value;
}

function compareTokenToReview(
  payload: {
    reviewId: string;
    handoffId: string;
    agent: string;
    mode: RunResult['mode'];
    repoRoot: string;
    inputManifestHash: string;
    registryHash: string;
    expiry: string;
  },
  review: ReviewMetadata,
): DispatchResult<void> {
  const comparisons: Array<[string, string, string]> = [
    ['review_id', payload.reviewId, review.review_id],
    ['handoff_id', payload.handoffId, review.handoff_id],
    ['agent', payload.agent, review.agent],
    ['mode', payload.mode, review.mode],
    ['repo_root', payload.repoRoot, review.repo_root],
    ['input_manifest_hash', payload.inputManifestHash, review.input_manifest_hash],
    ['registry_hash', payload.registryHash, review.registry_hash],
    ['expires_at', payload.expiry, review.expires_at],
  ];

  for (const [field, tokenValue, reviewValue] of comparisons) {
    if (String(tokenValue) !== String(reviewValue)) {
      return fail('HASH_MISMATCH', `Token/review mismatch for ${field}.`);
    }
  }

  return ok(undefined);
}

function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function isRecordedProcessAlive(pid: number, pgid: number): boolean {
  if (process.platform !== 'win32' && pgid > 0) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH')) {
        return true;
      }
    }
  }

  return pid > 0 ? isAlive(pid) : false;
}

function signalChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH')) {
        try {
          process.kill(child.pid, signal);
        } catch {
          // best effort
        }
        return;
      }
    }
  }

  try {
    process.kill(child.pid, signal);
  } catch {
    // best effort
  }
}

async function verifyReviewedBundle(
  reviewDir: string,
  expectedManifestHash: string,
): Promise<DispatchResult<{ manifest: ReviewManifest }>> {
  const manifestPath = join(reviewDir, 'metadata', 'input-manifest.json');
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, 'utf-8');
  } catch {
    return fail('REVIEW_NOT_FOUND', `Review manifest not found at ${manifestPath}.`);
  }

  if (sha256(manifestRaw) !== expectedManifestHash) {
    return fail('HASH_MISMATCH', 'Review bundle hash mismatch.');
  }

  let manifest: ReviewManifest;
  try {
    manifest = JSON.parse(manifestRaw) as ReviewManifest;
  } catch {
    return fail('PARSE_ERROR', 'Failed to parse review input manifest.');
  }

  const expectedFiles = [
    { relativePath: manifest.wrapper.path, sha256: manifest.wrapper.sha256 },
    { relativePath: manifest.handoff_snapshot.path, sha256: manifest.handoff_snapshot.sha256 },
    ...manifest.context_files.map((entry) => ({
      relativePath: entry.snapshot_path,
      sha256: entry.sha256,
    })),
  ];

  for (const entry of expectedFiles) {
    const absolutePath = join(reviewDir, entry.relativePath);
    try {
      if ((await sha256File(absolutePath)) !== entry.sha256) {
        return fail('HASH_MISMATCH', `Review bundle file hash mismatch: ${entry.relativePath}`);
      }
    } catch {
      return fail('HASH_MISMATCH', `Review bundle file missing: ${entry.relativePath}`);
    }
  }

  return ok({ manifest });
}

export async function launch(opts: LaunchOpts): Promise<DispatchResult<RunResult>> {
  const startedAt = new Date().toISOString();
  const repoRoot = resolve(opts.dir);

  const tokenResult = await readTokenFile(opts.reviewId, 'pending');
  if (!tokenResult.ok) return tokenResult;

  const verifyResult = await verifyToken(tokenResult.data);
  if (!verifyResult.ok) return verifyResult;

  const payload = verifyResult.data;
  if (payload.repoRoot !== repoRoot) {
    return fail('REPO_ROOT_MISMATCH', 'Current repo root does not match the reviewed repo root.');
  }

  const reviewDir = getReviewDir(repoRoot, opts.reviewId);
  let reviewMetadata: ReviewMetadata;
  try {
    reviewMetadata = JSON.parse(
      await readFile(join(reviewDir, 'metadata', 'review.json'), 'utf-8'),
    ) as ReviewMetadata;
  } catch (err) {
    return fail('REVIEW_NOT_FOUND', `Review metadata not found at ${join(reviewDir, 'metadata', 'review.json')}.`, err);
  }

  const reviewComparison = compareTokenToReview(payload, reviewMetadata);
  if (!reviewComparison.ok) return reviewComparison;

  const manifestResult = await verifyReviewedBundle(reviewDir, payload.inputManifestHash);
  if (!manifestResult.ok) return manifestResult;

  const registryResult = await loadRegistry();
  if (!registryResult.ok) return registryResult;

  if (registryResult.data.hash !== payload.registryHash) {
    return fail('HASH_MISMATCH', 'Registry hash mismatch. The agent registry has changed since review.');
  }

  const agentConfigResult = resolveAgentConfig(registryResult.data.data, payload.agent, payload.mode);
  if (!agentConfigResult.ok) return agentConfigResult;

  const moveToLaunching = await moveToken(opts.reviewId, 'pending', 'launching');
  if (!moveToLaunching.ok) return moveToLaunching;

  const runId = `RUN-${randomUUID()}`;
  const runDir = getRunDir(repoRoot, payload.handoffId, runId);
  const agentVisibleDir = join(runDir, 'agent-visible');
  const metadataDir = join(runDir, 'metadata');
  await mkdir(agentVisibleDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });

  await copyTree(join(reviewDir, 'agent-visible'), agentVisibleDir);
  await writeJsonAtomic(join(metadataDir, 'input-manifest.json'), manifestResult.data.manifest);
  await writeJsonAtomic(join(metadataDir, 'review.json'), reviewMetadata);
  await writeLaunchMetadata(metadataDir, {
    reviewId: opts.reviewId,
    runId,
    tokenState: 'launching',
    startedAt,
  });

  const responsePath = join(runDir, 'response.md');
  const stdoutPath = join(metadataDir, 'stdout.log');
  const stderrPath = join(metadataDir, 'stderr.log');
  const wrapperPath = join(agentVisibleDir, 'wrapper.md');
  const handoffPath = join(agentVisibleDir, 'handoff.snapshot.md');
  const contextDir = join(agentVisibleDir, 'context');
  const wrapperContent = await readFile(wrapperPath, 'utf-8');

  const env = buildEnv(
    repoRoot,
    runDir,
    agentVisibleDir,
    handoffPath,
    contextDir,
    responsePath,
    opts.reviewId,
    runId,
    agentConfigResult.data.env,
  );

  const { command, args } = buildCommand(
    agentConfigResult.data,
    payload.mode,
    wrapperContent,
    wrapperPath,
    responsePath,
    repoRoot,
  );
  const argv = [command, ...args];
  const redactionPlaceholders: Array<[string, string]> = [
    [repoRoot, '<repo_root>'],
    [wrapperPath, '<wrapper_path>'],
    [responsePath, '<response_path>'],
    [wrapperContent, '<wrapper_content>'],
  ];
  const argvRedacted = argv.map((value) => sanitizeAbsoluteArg(value, redactionPlaceholders));

  const stdoutTarget = agentConfigResult.data.response_transport.kind === 'stdout_capture'
    ? responsePath
    : stdoutPath;
  const stdoutStream = createWriteStream(stdoutTarget, { flags: 'w' });
  const stderrStream = createWriteStream(stderrPath, { flags: 'w' });

  let child: ChildProcess | undefined;
  let confirmedStart = false;
  let requestedStatus: Exclude<TerminalRunStatus, 'rejected' | 'completed'> | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let terminalStatus: TerminalRunStatus | null = null;

  const finalize = async (
    status: TerminalRunStatus,
    exitCode: number,
    errorMessage?: string,
  ): Promise<{ response: string; emptyResponse: boolean; finalStatus: TerminalRunStatus }> => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);

    await new Promise<void>((resolvePromise) => {
      stdoutStream.end(() => resolvePromise());
    });
    await new Promise<void>((resolvePromise) => {
      stderrStream.end(() => resolvePromise());
    });

    let response = '';
    if (await pathExists(responsePath)) {
      response = await readFile(responsePath, 'utf-8');
    }

    const bodyWithoutFrontmatter = stripLeadingFrontmatter(response).trim();
    let finalStatus = status;
    let emptyResponse = false;
    if (finalStatus === 'completed' && bodyWithoutFrontmatter === '') {
      emptyResponse = true;
      response = buildEmptyBodyDiagnostic(agentConfigResult.data.response_transport.kind);
      finalStatus = 'failed';
    }

    const completedAt = new Date().toISOString();
    terminalStatus = finalStatus;
    const normalizedResponse = normalizeResponseContent(response, {
      schema_version: 1,
      run_id: runId,
      handoff_id: payload.handoffId,
      agent: payload.agent,
      input_manifest_hash: payload.inputManifestHash,
      status: finalStatus,
      created_at: completedAt,
    });
    await writeFile(responsePath, normalizedResponse, 'utf-8');
    const responseSha256 = await sha256TaggedFile(responsePath);

    await writeLaunchMetadata(metadataDir, {
      reviewId: opts.reviewId,
      runId,
      tokenState: confirmedStart ? 'consumed' : 'rejected',
      startedAt,
      completedAt,
      exitCode,
      error: emptyResponse ? 'Empty agent response' : errorMessage,
      responsePath,
      stdoutPath: agentConfigResult.data.response_transport.kind === 'file' ? stdoutPath : null,
      stderrPath,
    });

    if (child?.pid) {
      await writeStateMetadata(metadataDir, {
        runId,
        status: finalStatus,
        pid: child.pid,
        pgid: child.pid,
        startedAt,
        heartbeatAt: completedAt,
      });
    }

    await writeJsonAtomic(join(metadataDir, 'meta.json'), {
      schema_version: 1,
      run_id: runId,
      handoff_id: payload.handoffId,
      agent: payload.agent,
      mode: payload.mode,
      operator_id: process.env['USER'] || process.env['USERNAME'] || 'unknown',
      review_id: opts.reviewId,
      input_manifest_hash: payload.inputManifestHash,
      registry_hash: payload.registryHash,
      response_sha256: responseSha256,
      started_at: startedAt,
      completed_at: completedAt,
      status: finalStatus,
      launcher_version: '1.0.0',
      argv_redacted: argvRedacted,
      timeout_seconds: agentConfigResult.data.timeout_seconds ?? 1800,
      exit_code: exitCode,
      ...(emptyResponse || errorMessage ? { error: emptyResponse ? 'Empty agent response' : errorMessage } : {}),
      response_path: responsePath,
      stdout_path: agentConfigResult.data.response_transport.kind === 'file' ? stdoutPath : null,
      stderr_path: stderrPath,
    });

    return { response: normalizedResponse, emptyResponse, finalStatus };
  };

  const requestTermination = (status: Exclude<TerminalRunStatus, 'rejected' | 'completed'>): void => {
    if (!child?.pid || terminalStatus) {
      return;
    }
    requestedStatus ??= status;
    signalChildProcessGroup(child, 'SIGTERM');

    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (child) {
          signalChildProcessGroup(child, 'SIGKILL');
        }
      }, CANCEL_GRACE_MS);
      killTimer.unref?.();
    }
  };

  const cancelRun = (): void => {
    requestTermination('cancelled');
  };

  process.once('SIGINT', cancelRun);
  process.once('SIGTERM', cancelRun);
  process.once('SIGHUP', cancelRun);

  try {
    const spawnInvocation = buildSpawnInvocation(command, args);
    child = spawn(spawnInvocation.command, spawnInvocation.args, {
      cwd: agentVisibleDir,
      env,
      detached: true,
      stdio: [
        agentConfigResult.data.instruction_transport.kind === 'stdin' ? 'pipe' : 'ignore',
        'pipe',
        'pipe',
      ],
      shell: spawnInvocation.shell,
    });

    if (child.stdout) {
      child.stdout.pipe(stdoutStream);
    }
    if (child.stderr) {
      child.stderr.pipe(stderrStream);
    }

    const spawnPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      child?.once('spawn', () => resolvePromise());
      child?.once('error', (err) => rejectPromise(err));
    });

    const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child?.once('close', (code, signal) => {
        resolvePromise({
          code,
          signal: signal as NodeJS.Signals | null,
        });
      });
    });

    if (agentConfigResult.data.instruction_transport.kind === 'stdin' && child.stdin) {
      child.stdin.end(wrapperContent);
    }

    await spawnPromise;
    confirmedStart = true;

    if (!child.pid) {
      throw new Error('Spawned child did not report a pid.');
    }

    await writeStateMetadata(metadataDir, {
      runId,
      status: 'launching',
      pid: child.pid,
      pgid: child.pid,
      startedAt,
      heartbeatAt: startedAt,
    });

    const moveToConsumed = await moveToken(opts.reviewId, 'launching', 'consumed');
    if (!moveToConsumed.ok) {
      requestTermination('failed');
      const close = await closePromise;
      await finalize('failed', close.code ?? 1, 'Failed to move launch token to consumed after spawn.');
      return fail('LAUNCH_FAILED', 'Failed to move launch token to consumed after spawn.', moveToConsumed);
    }

    await writeLaunchMetadata(metadataDir, {
      reviewId: opts.reviewId,
      runId,
      tokenState: 'consumed',
      startedAt,
      responsePath,
      stdoutPath: agentConfigResult.data.response_transport.kind === 'file' ? stdoutPath : null,
      stderrPath,
    });

    heartbeatTimer = setInterval(async () => {
      if (!child?.pid || terminalStatus) {
        return;
      }
      if (isRecordedProcessAlive(child.pid, child.pid)) {
        await writeStateMetadata(metadataDir, {
          runId,
          status: 'launching',
          pid: child.pid,
          pgid: child.pid,
          startedAt,
          heartbeatAt: new Date().toISOString(),
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    timeoutTimer = setTimeout(() => {
      requestTermination('timed_out');
    }, (agentConfigResult.data.timeout_seconds ?? 1800) * 1000);
    timeoutTimer.unref?.();

    const close = await closePromise;
    const exitCode = close.code ?? 1;
    const defaultStatus = requestedStatus ?? (close.signal ? 'failed' : exitCode === 0 ? 'completed' : 'failed');
    const errorMessage = defaultStatus === 'completed'
      ? undefined
      : close.signal
        ? `Agent exited due to signal ${close.signal}.`
        : exitCode !== 0
          ? `Agent exited with code ${exitCode}.`
          : undefined;
    const result = await finalize(defaultStatus, exitCode, errorMessage);

    if (result.finalStatus !== 'completed') {
      const errorCode = result.emptyResponse ? 'EMPTY_RESPONSE' : 'LAUNCH_FAILED';
      const message = result.emptyResponse
        ? 'Agent produced an empty response body.'
        : `Agent launch completed with terminal status "${result.finalStatus}".`;
      return fail(errorCode, message, {
        runId,
        runDir,
        status: result.finalStatus,
        responsePath,
        metaPath: join(metadataDir, 'meta.json'),
      });
    }

    return ok({
      runId,
      reviewId: opts.reviewId,
      handoffId: payload.handoffId,
      agent: payload.agent,
      mode: payload.mode,
      runDir,
      exitCode,
      response: result.response,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (!confirmedStart) {
      await moveToken(opts.reviewId, 'launching', 'rejected');
      await writeLaunchMetadata(metadataDir, {
        reviewId: opts.reviewId,
        runId,
        tokenState: 'rejected',
        startedAt,
        completedAt: new Date().toISOString(),
        error: 'Agent process failed before confirmed start.',
        responsePath,
        stdoutPath: agentConfigResult.data.response_transport.kind === 'file' ? stdoutPath : null,
        stderrPath,
      });
    }

    if (!terminalStatus) {
      await finalize(
        confirmedStart ? 'failed' : 'rejected',
        1,
        confirmedStart ? 'Agent process failed after confirmed start.' : 'Agent process failed before confirmed start.',
      );
    }

    return fail('LAUNCH_FAILED', 'Agent process failed to launch.', {
      error: err,
      runId,
      runDir,
      status: confirmedStart ? 'failed' : 'rejected',
      responsePath,
      metaPath: join(metadataDir, 'meta.json'),
    });
  } finally {
    process.removeListener('SIGINT', cancelRun);
    process.removeListener('SIGTERM', cancelRun);
    process.removeListener('SIGHUP', cancelRun);
    if (!terminalStatus) {
      stdoutStream.end();
      stderrStream.end();
    }
  }
}
