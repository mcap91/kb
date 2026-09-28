/**
 * WK-0175 `restamp` — mechanizes the last step of the BASE_DRIFT re-read flow
 * (admission.ts's `checkStamp` fix message): sets an HO's `base_sha` (and
 * `base_wiki_sha`, when already declared) to current HEAD, replacing
 * hand-editing frontmatter. Does not perform or verify the re-read itself —
 * that stays the caller's job before calling this.
 */
import { execFile as execFileCb } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { DispatchResult } from './errors.js';
import { ok, fail } from './errors.js';
import { parseHandoffContent } from './ho.js';
import { probeWikiSource } from './wiki-source.js';

const execFile = promisify(execFileCb);

export interface RestampOpts {
  dir: string;
  handoff: string;
}

export interface RestampResult {
  handoffId: string;
  handoffPath: string;
  base_sha: string;
  base_wiki_sha?: string;
}

/** Replaces a top-level `field: ...` line inside a frontmatter block, or appends it if absent. */
function setFrontmatterField(frontmatterText: string, field: string, value: string): string {
  const re = new RegExp(`^${field}\\s*:.*$`, 'm');
  const line = `${field}: "${value}"`;
  if (re.test(frontmatterText)) {
    return frontmatterText.replace(re, line);
  }
  return `${frontmatterText}\n${line}`;
}

/** Splits `---\n<frontmatter>\n---\n<body>` the same way ho.ts's parser does. */
function splitFrontmatter(content: string): { open: string; frontmatterText: string; rest: string } | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^(---\n)([\s\S]*?)(\n---\n?[\s\S]*)$/);
  if (!match) return null;
  return { open: match[1] ?? '', frontmatterText: match[2] ?? '', rest: match[3] ?? '' };
}

/**
 * Restamps an HO's `base_sha` (and `base_wiki_sha`, when the HO already
 * declares one) to the repo's (and nested wiki's) current HEAD, rewriting
 * only those frontmatter fields — everything else in the file is untouched.
 */
export async function restamp(opts: RestampOpts): Promise<DispatchResult<RestampResult>> {
  const targetDir = resolve(opts.dir);
  const handoffPath = resolve(targetDir, opts.handoff);

  let content: string;
  try {
    content = await readFile(handoffPath, 'utf-8');
  } catch (err) {
    return fail('FILE_NOT_FOUND', `Could not read handoff at ${handoffPath}.`, err);
  }

  const parsed = parseHandoffContent(content, handoffPath);
  if (!parsed.ok) return parsed;

  const split = splitFrontmatter(content);
  if (!split) {
    return fail('BAD_RECORD', `Handoff file must begin with YAML frontmatter delimited by --- markers: ${handoffPath}`);
  }

  let baseSha: string;
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: targetDir });
    baseSha = stdout.trim();
  } catch (err) {
    return fail('LOOKUP_FAILED', `Failed to resolve HEAD in ${targetDir}.`, err);
  }

  let frontmatterText = setFrontmatterField(split.frontmatterText, 'base_sha', baseSha);

  let baseWikiSha: string | undefined;
  if (parsed.data.base_wiki_sha !== undefined) {
    const wiki = await probeWikiSource(targetDir);
    if (!wiki.ok) return wiki;
    if (wiki.data.head === null) {
      return fail(
        'LOOKUP_FAILED',
        `Handoff ${parsed.data.id} declares base_wiki_sha, but wiki/ is tracked (no separate HEAD) in ${targetDir}.`,
      );
    }
    baseWikiSha = wiki.data.head;
    frontmatterText = setFrontmatterField(frontmatterText, 'base_wiki_sha', baseWikiSha);
  }

  const newContent = `${split.open}${frontmatterText}${split.rest}`;
  try {
    await writeFile(handoffPath, newContent, 'utf-8');
  } catch (err) {
    return fail('FILE_WRITE_ERROR', `Failed to write handoff at ${handoffPath}.`, err);
  }

  return ok({
    handoffId: parsed.data.id,
    handoffPath,
    base_sha: baseSha,
    ...(baseWikiSha !== undefined ? { base_wiki_sha: baseWikiSha } : {}),
  });
}
