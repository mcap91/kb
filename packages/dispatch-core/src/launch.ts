import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
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
    tokenState: 'launching' | 'consumed' | 'rejected';
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

  await writeFile(
    join(metadataDir, 'launch.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf-8',
  );
}

function spawnAgent(
  agent: AgentLauncherConfig,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  stdinText?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timeoutMs = (agent.timeout_seconds ?? 1800) * 1000;
    const timeoutId = setTimeout(() => {
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });

    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

async function verifyReviewedBundle(reviewDir: string, expectedManifestHash: string): Promise<DispatchResult<{
  manifest: {
    handoff_id: string;
    mode: RunResult['mode'];
    wrapper: { path: string; sha256: string };
    handoff_snapshot: { path: string; sha256: string };
    context_files: Array<{ snapshot_path: string; sha256: string }>;
  };
}>> {
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

  let manifest: {
    handoff_id: string;
    mode: RunResult['mode'];
    wrapper: { path: string; sha256: string };
    handoff_snapshot: { path: string; sha256: string };
    context_files: Array<{ snapshot_path: string; sha256: string }>;
  };

  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
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
  if (!verifyResult.ok) {
    await moveToken(opts.reviewId, 'pending', 'rejected');
    return verifyResult;
  }

  const payload = verifyResult.data;
  if (payload.repoRoot !== repoRoot) {
    await moveToken(opts.reviewId, 'pending', 'rejected');
    return fail('REPO_ROOT_MISMATCH', 'Current repo root does not match the reviewed repo root.');
  }

  const reviewDir = getReviewDir(repoRoot, opts.reviewId);
  const manifestResult = await verifyReviewedBundle(reviewDir, payload.inputManifestHash);
  if (!manifestResult.ok) {
    await moveToken(opts.reviewId, 'pending', 'rejected');
    return manifestResult;
  }

  const registryResult = await loadRegistry();
  if (!registryResult.ok) {
    await moveToken(opts.reviewId, 'pending', 'rejected');
    return registryResult;
  }

  if (registryResult.data.hash !== payload.registryHash) {
    await moveToken(opts.reviewId, 'pending', 'rejected');
    return fail('HASH_MISMATCH', 'Registry hash mismatch. The agent registry has changed since review.');
  }

  const agentConfigResult = resolveAgentConfig(registryResult.data.data, payload.agent, payload.mode);
  if (!agentConfigResult.ok) {
    await moveToken(opts.reviewId, 'pending', 'rejected');
    return agentConfigResult;
  }

  const moveToLaunching = await moveToken(opts.reviewId, 'pending', 'launching');
  if (!moveToLaunching.ok) return moveToLaunching;

  const runId = `RUN-${randomUUID()}`;
  const runDir = getRunDir(repoRoot, payload.handoffId, runId);
  const agentVisibleDir = join(runDir, 'agent-visible');
  const metadataDir = join(runDir, 'metadata');
  await mkdir(agentVisibleDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });

  await copyTree(join(reviewDir, 'agent-visible'), agentVisibleDir);
  await writeFile(
    join(metadataDir, 'input-manifest.json'),
    await readFile(join(reviewDir, 'metadata', 'input-manifest.json'), 'utf-8'),
    'utf-8',
  );
  await writeFile(
    join(metadataDir, 'review.json'),
    await readFile(join(reviewDir, 'metadata', 'review.json'), 'utf-8'),
    'utf-8',
  );
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

  let spawnResult: { exitCode: number; stdout: string; stderr: string };
  try {
    spawnResult = await spawnAgent(
      agentConfigResult.data,
      command,
      args,
      env,
      agentVisibleDir,
      agentConfigResult.data.instruction_transport.kind === 'stdin' ? wrapperContent : undefined,
    );
  } catch (err) {
    const completedAt = new Date().toISOString();
    await moveToken(opts.reviewId, 'launching', 'rejected');
    await writeLaunchMetadata(metadataDir, {
      reviewId: opts.reviewId,
      runId,
      tokenState: 'rejected',
      startedAt,
      completedAt,
      error: 'Agent process failed to spawn.',
    });
    await writeFile(
      join(metadataDir, 'meta.json'),
      `${JSON.stringify({
        schema_version: 1,
        review_id: opts.reviewId,
        run_id: runId,
        handoff_id: payload.handoffId,
        agent: payload.agent,
        mode: payload.mode,
        status: 'rejected',
        started_at: startedAt,
        completed_at: completedAt,
        error: 'Agent process failed to spawn.',
      }, null, 2)}\n`,
      'utf-8',
    );
    return fail('LAUNCH_FAILED', 'Agent process failed to spawn.', err);
  }

  const stdoutLogPath = spawnResult.stdout.trim() ? stdoutPath : null;
  const stderrLogPath = spawnResult.stderr.trim() ? stderrPath : null;

  if (stdoutLogPath) {
    await writeFile(stdoutPath, spawnResult.stdout, 'utf-8');
  }
  if (stderrLogPath) {
    await writeFile(stderrPath, spawnResult.stderr, 'utf-8');
  }

  let response: string | undefined;
  try {
    response = await readFile(responsePath, 'utf-8');
  } catch {
    // response file is optional for stdout transport
  }

  if ((!response || response.trim() === '') && spawnResult.stdout.trim()) {
    response = spawnResult.stdout.trim();
    await writeFile(responsePath, `${response}\n`, 'utf-8');
  }

  const completedAt = new Date().toISOString();
  if (!response || response.trim() === '') {
    await moveToken(opts.reviewId, 'launching', 'rejected');
    await writeLaunchMetadata(metadataDir, {
      reviewId: opts.reviewId,
      runId,
      tokenState: 'rejected',
      startedAt,
      completedAt,
      exitCode: spawnResult.exitCode,
      error: 'Empty agent response',
      responsePath: null,
      stdoutPath: stdoutLogPath,
      stderrPath: stderrLogPath,
    });
    await writeFile(
      join(metadataDir, 'meta.json'),
      `${JSON.stringify({
        schema_version: 1,
        review_id: opts.reviewId,
        run_id: runId,
        handoff_id: payload.handoffId,
        agent: payload.agent,
        mode: payload.mode,
        status: 'rejected',
        exit_code: spawnResult.exitCode,
        started_at: startedAt,
        completed_at: completedAt,
        error: 'Empty agent response',
        response_path: null,
        stdout_path: stdoutLogPath,
        stderr_path: stderrLogPath,
      }, null, 2)}\n`,
      'utf-8',
    );
    return fail('EMPTY_RESPONSE', 'Agent produced an empty response. Launch is considered failed.');
  }

  await moveToken(opts.reviewId, 'launching', 'consumed');
  await writeLaunchMetadata(metadataDir, {
    reviewId: opts.reviewId,
    runId,
    tokenState: 'consumed',
    startedAt,
    completedAt,
    exitCode: spawnResult.exitCode,
    responsePath,
    stdoutPath: stdoutLogPath,
    stderrPath: stderrLogPath,
  });
  await writeFile(
    join(metadataDir, 'meta.json'),
    `${JSON.stringify({
      schema_version: 1,
      review_id: opts.reviewId,
      run_id: runId,
      handoff_id: payload.handoffId,
      agent: payload.agent,
      mode: payload.mode,
      status: 'completed',
      exit_code: spawnResult.exitCode,
      started_at: startedAt,
      completed_at: completedAt,
      response_path: responsePath,
      stdout_path: stdoutLogPath,
      stderr_path: stderrLogPath,
    }, null, 2)}\n`,
    'utf-8',
  );

  return ok({
    runId,
    reviewId: opts.reviewId,
    handoffId: payload.handoffId,
    agent: payload.agent,
    mode: payload.mode,
    runDir,
    exitCode: spawnResult.exitCode,
    response,
    startedAt,
    completedAt,
  });
}
