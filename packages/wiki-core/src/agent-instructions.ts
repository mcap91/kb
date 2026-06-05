import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, fail, type Result } from './errors.js';
import { debug } from './debug.js';

const BEGIN_MARKER = '<!-- BEGIN kb-managed -->';
const END_MARKER = '<!-- END kb-managed -->';
const MANAGED_COMMENT = 'Managed by kb — edits inside this block are overwritten by `kb bootstrap` / `kb sync-contract`; edit outside the markers.';

const TARGET_FILES = ['AGENTS.md', 'CLAUDE.md'];

interface ManagedBlockEntry {
  file: string;
  action: 'created' | 'updated' | 'unchanged';
}

interface WriteManagedBlockOpts {
  dryRun?: boolean;
}

function buildWrappedBlock(body: string): string {
  return `${BEGIN_MARKER}\n${MANAGED_COMMENT}\n\n${body}\n${END_MARKER}`;
}

function processFile(
  filePath: string,
  wrappedBlock: string,
  dryRun: boolean,
): ManagedBlockEntry {
  const fileName = path.basename(filePath);

  if (!fs.existsSync(filePath)) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, wrappedBlock + '\n', 'utf-8');
    }
    debug(`created ${fileName} with managed block`);
    return { file: fileName, action: 'created' };
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    const currentBlock = existing.slice(beginIdx, endIdx + END_MARKER.length);

    if (currentBlock === wrappedBlock) {
      debug(`${fileName} managed block unchanged`);
      return { file: fileName, action: 'unchanged' };
    }

    const updated = before + wrappedBlock + after;
    if (!dryRun) {
      fs.writeFileSync(filePath, updated, 'utf-8');
    }
    debug(`updated managed block in ${fileName}`);
    return { file: fileName, action: 'updated' };
  }

  // No markers — insert after leading H1 or at top
  const lines = existing.split('\n');
  let insertIdx = 0;
  if (lines.length > 0 && lines[0].startsWith('# ')) {
    insertIdx = 1;
  }

  const before = lines.slice(0, insertIdx).join('\n');
  const after = lines.slice(insertIdx).join('\n');

  let result: string;
  if (before) {
    result = before + '\n\n' + wrappedBlock + '\n' + (after.startsWith('\n') ? after : '\n' + after);
  } else {
    result = wrappedBlock + '\n' + (after.startsWith('\n') ? after : '\n' + after);
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, result, 'utf-8');
  }
  debug(`inserted managed block into ${fileName}`);
  return { file: fileName, action: 'created' };
}

export function writeManagedBlock(
  targetDir: string,
  blockBody: string,
  opts?: WriteManagedBlockOpts,
): Result<ManagedBlockEntry[]> {
  const dryRun = opts?.dryRun ?? false;
  const wrappedBlock = buildWrappedBlock(blockBody);
  const results: ManagedBlockEntry[] = [];

  for (const file of TARGET_FILES) {
    const filePath = path.join(targetDir, file);
    results.push(processFile(filePath, wrappedBlock, dryRun));
  }

  return ok(results);
}
