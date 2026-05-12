import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { DEFAULT_LIMITS, assertPathInside, canonicalizePath, loadHandoff } from './handoff.js';
import { getWrapperForMode, WRAPPER_VERSION } from './prompts.js';
import { loadRegistry, resolveAgentConfig } from './registry.js';
import type {
  ReviewOpts,
  ReviewResult,
  TokenPayload,
} from './types.js';
import type { DispatchResult } from './errors.js';
import { fail, ok } from './errors.js';
import { createToken, writeTokenFile } from './token.js';
import { getReviewDir } from './paths.js';

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function hashRelativePath(path: string): string {
  return sha256(path).slice(0, 12);
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

export async function review(opts: ReviewOpts): Promise<DispatchResult<ReviewResult>> {
  if (!opts.reviewedAndAcceptRisks) {
    return fail(
      'REVIEW_FAILED',
      'Operator acknowledgment required: pass reviewedAndAcceptRisks / --reviewed-and-accept-risks before review.',
    );
  }

  const repoRoot = resolve(opts.dir);
  const handoffRelative = opts.handoff;
  const handoffAbsolute = resolve(repoRoot, handoffRelative);

  const handoffRealPath = await canonicalizePath(handoffAbsolute).catch(() => null);
  if (!handoffRealPath) {
    return fail('FILE_NOT_FOUND', `Handoff file not found: ${handoffAbsolute}`);
  }

  const insideRepo = assertPathInside(repoRoot, handoffRealPath, 'Handoff must live inside the repo root.');
  if (!insideRepo.ok) return insideRepo;

  const registryResult = await loadRegistry();
  if (!registryResult.ok) return registryResult;

  const handoffResult = await loadHandoff(handoffRealPath, DEFAULT_LIMITS);
  if (!handoffResult.ok) return handoffResult;

  const handoff = handoffResult.data;
  if (!handoff.frontmatter.allowed_agents.includes(opts.agent)) {
    return fail(
      'AGENT_NOT_ALLOWED',
      `Agent "${opts.agent}" is not in the handoff's allowed_agents list: [${handoff.frontmatter.allowed_agents.join(', ')}].`,
    );
  }

  const agentConfigResult = resolveAgentConfig(registryResult.data.data, opts.agent, handoff.frontmatter.mode);
  if (!agentConfigResult.ok) return agentConfigResult;

  if (handoff.readFirst.length > DEFAULT_LIMITS.maxLinkedFiles) {
    return fail(
      'INVALID_HANDOFF',
      `Read First exceeds max linked file count of ${DEFAULT_LIMITS.maxLinkedFiles}.`,
    );
  }

  const reviewId = `RV-${randomUUID()}`;
  const reviewDir = getReviewDir(repoRoot, reviewId);
  const agentVisibleDir = join(reviewDir, 'agent-visible');
  const contextDir = join(agentVisibleDir, 'context');
  const metadataDir = join(reviewDir, 'metadata');

  await mkdir(contextDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });

  const handoffSnapshotPath = join(agentVisibleDir, 'handoff.snapshot.md');
  await writeFile(handoffSnapshotPath, handoff.content, 'utf-8');

  const totalSizes = [await stat(handoffSnapshotPath).then((item) => item.size)];
  const contextFiles: Array<{
    source_path: string;
    snapshot_path: string;
    sha256: string;
  }> = [];

  for (const relativePath of handoff.readFirst) {
    const absolutePath = await canonicalizePath(resolve(repoRoot, relativePath)).catch(() => null);
    if (!absolutePath) {
      return fail('FILE_NOT_FOUND', `Read First references a file that does not exist: ${relativePath}`);
    }

    const inside = assertPathInside(repoRoot, absolutePath, `Read First path escapes repo root: ${relativePath}`);
    if (!inside.ok) return inside;

    const fileStat = await stat(absolutePath);
    if (fileStat.size > DEFAULT_LIMITS.maxLinkedFileBytes) {
      return fail('INVALID_HANDOFF', `Read First file exceeds max size: ${relativePath}`);
    }

    totalSizes.push(fileStat.size);
    const snapshotFileName = `${hashRelativePath(relativePath)}${extname(relativePath) || '.md'}`;
    const snapshotPath = join(contextDir, snapshotFileName);
    await writeFile(snapshotPath, await readFile(absolutePath));
    contextFiles.push({
      source_path: relativePath,
      snapshot_path: `agent-visible/context/${snapshotFileName}`,
      sha256: await sha256File(snapshotPath),
    });
  }

  const totalReviewedBytes = totalSizes.reduce((sum, size) => sum + size, 0);
  if (totalReviewedBytes > DEFAULT_LIMITS.maxTotalReviewedBytes) {
    return fail(
      'INVALID_HANDOFF',
      `Reviewed bundle exceeds max total size of ${DEFAULT_LIMITS.maxTotalReviewedBytes} bytes.`,
    );
  }

  const wrapperPath = join(agentVisibleDir, 'wrapper.md');
  await writeFile(wrapperPath, getWrapperForMode(handoff.frontmatter.mode), 'utf-8');

  const inputManifest = {
    schema_version: 1,
    handoff_id: handoff.frontmatter.id,
    subject: handoff.frontmatter.subject,
    mode: handoff.frontmatter.mode,
    wrapper_version: WRAPPER_VERSION,
    wrapper: {
      path: 'agent-visible/wrapper.md',
      wrapper_version: WRAPPER_VERSION,
      sha256: await sha256File(wrapperPath),
    },
    handoff_snapshot: {
      path: 'agent-visible/handoff.snapshot.md',
      sha256: await sha256File(handoffSnapshotPath),
    },
    context_files: contextFiles,
    captures_declared_inputs_only: true,
  };

  const manifestJson = `${JSON.stringify(inputManifest, null, 2)}\n`;
  const inputManifestPath = join(metadataDir, 'input-manifest.json');
  await writeAtomic(inputManifestPath, manifestJson);
  const inputManifestHash = sha256(manifestJson);

  const expiresAt = new Date(Date.now() + (30 * 60 * 1000)).toISOString();
  const reviewJson = {
    schema_version: 1,
    review_id: reviewId,
    handoff_id: handoff.frontmatter.id,
    agent: opts.agent,
    mode: handoff.frontmatter.mode,
    repo_root: repoRoot,
    input_manifest_hash: inputManifestHash,
    registry_hash: registryResult.data.hash,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    limits: {
      max_handoff_bytes: DEFAULT_LIMITS.maxHandoffBytes,
      max_linked_file_bytes: DEFAULT_LIMITS.maxLinkedFileBytes,
      max_total_reviewed_bytes: DEFAULT_LIMITS.maxTotalReviewedBytes,
      max_linked_files: DEFAULT_LIMITS.maxLinkedFiles,
    },
  };
  await writeAtomic(join(metadataDir, 'review.json'), `${JSON.stringify(reviewJson, null, 2)}\n`);

  const payload: TokenPayload = {
    reviewId,
    handoffId: handoff.frontmatter.id,
    agent: opts.agent,
    mode: handoff.frontmatter.mode,
    repoRoot,
    inputManifestHash,
    registryHash: registryResult.data.hash,
    expiry: expiresAt,
  };

  const tokenResult = await createToken(payload);
  if (!tokenResult.ok) return tokenResult;

  const tokenPath = await writeTokenFile(tokenResult.data, 'pending');

  return ok({
    reviewId,
    handoffId: handoff.frontmatter.id,
    agent: opts.agent,
    mode: handoff.frontmatter.mode,
    bundlePath: reviewDir,
    tokenPath,
    expiry: expiresAt,
  });
}
