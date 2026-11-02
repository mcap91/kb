/**
 * Judge prompt build/parse and its hash pin (WK-0237 Resolutions 12; HO-0151
 * Constraints). The judge sees exactly Resolutions 12's inputs (a)-(d): the
 * planted question, the row's choice, the citation identifiers
 * `citations.ts` parsed from the row, and the text of each cited file --
 * never the row's `searched`/`evidence`/`reason` prose and never the
 * planner's reply text. Pure string functions: no process launch, no
 * network, no model call; the template itself lives in `judge-prompt.md`
 * and is passed in by the caller, not read from disk here.
 */
import { createHash } from 'node:crypto';

export type JudgeVerdict = 'answers' | 'does-not-answer' | 'invalid';

export interface CitedFile {
  id: string;
  text: string;
}

export interface BuildJudgePromptInput {
  plantedQuestion: string;
  choice: string;
  citedFiles: CitedFile[];
}

const PLANTED_QUESTION_PLACEHOLDER = '{{PLANTED_QUESTION}}';
const CHOICE_PLACEHOLDER = '{{CHOICE}}';
const CITED_FILES_PLACEHOLDER = '{{CITED_FILES}}';

function renderCitedFilesBlock(citedFiles: CitedFile[]): string {
  return citedFiles.map((f) => `### ${f.id}\n\n${f.text}`).join('\n\n');
}

/**
 * Renders `template` with exactly Resolutions 12's (a)-(d) inputs. Nothing
 * else reaches the output: no `searched`/`evidence`/`reason` prose, no reply
 * text -- the function signature structurally excludes them.
 */
export function buildJudgePrompt(template: string, input: BuildJudgePromptInput): string {
  return template
    .split(PLANTED_QUESTION_PLACEHOLDER)
    .join(input.plantedQuestion)
    .split(CHOICE_PLACEHOLDER)
    .join(input.choice)
    .split(CITED_FILES_PLACEHOLDER)
    .join(renderCitedFilesBlock(input.citedFiles));
}

/**
 * Reads the judge reply's first line exactly, per the template's
 * requirement ("exactly `VERDICT: answers` or `VERDICT: does-not-answer`").
 * Leading whitespace, a different first line, or an empty reply all parse
 * as `invalid`.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const firstLine = text.split('\n')[0] ?? '';
  if (firstLine === 'VERDICT: answers') return 'answers';
  if (firstLine === 'VERDICT: does-not-answer') return 'does-not-answer';
  return 'invalid';
}

/** sha256 hex digest of the judge prompt template, pinned per run (WK-0237 scope 15.4). */
export function judgePromptSha256(template: string): string {
  return createHash('sha256').update(template, 'utf8').digest('hex');
}
