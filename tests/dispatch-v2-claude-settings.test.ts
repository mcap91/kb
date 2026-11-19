/**
 * The absolute Read rule, plus managed Claude editing: Edit/Write/
 * NotebookEdit are denied in every mode, so Bash is Claude's only write
 * path; no more per-write_scope `Edit(...)` allow entries — a bare-name deny
 * wins over them, so they would be dead grants. Pure/synchronous, no bwrap
 * required. No personal/absolute paths in fixtures —
 * clonePath below is synthetic.
 */
import { describe, expect, it } from 'vitest';

import { buildClaudeSettingsJson } from '../packages/dispatch-core/src/pipeline.js';

const clonePath = '/home/user/.kb-dispatch/clones/RUN-CLAUDE-SETTINGS';

describe('buildClaudeSettingsJson — exact-file binds, no Edit allow entries', () => {
  it('mode=implement with a mixed write_scope (dir entry with a trailing slash, file entry): allow is Read + Bash only (named behavior change — no Edit(...) entries), Read is absolute', () => {
    const writeScope = ['skills/ntfy-bridge/', 'docs/notes.md'];
    const json = buildClaudeSettingsJson(writeScope, clonePath, 'implement', []);
    const settings = JSON.parse(json);

    expect(settings.permissions.allow).toEqual([`Read(//${clonePath.slice(1)}/**)`, 'Bash']);
    expect(settings.permissions.allow.some((entry: string) => entry.startsWith('Edit('))).toBe(false);
  });

  it('every mode denies Edit, Write, NotebookEdit (named behavior change — previously implement-only allowed Edit)', () => {
    for (const mode of ['implement', 'review', 'code_review', 'redteam']) {
      const writeScope = mode === 'implement' ? ['docs/notes.md'] : [];
      const json = buildClaudeSettingsJson(writeScope, clonePath, mode, []);
      const settings = JSON.parse(json);
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']),
      );
    }
  });

  it('non-implement modes: allow is Read + Bash only', () => {
    const json = buildClaudeSettingsJson([], clonePath, 'review', []);
    const settings = JSON.parse(json);
    expect(settings.permissions.allow).toEqual([`Read(//${clonePath.slice(1)}/**)`, 'Bash']);
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
  });

  it('still throws for mode=implement with an empty write_scope', () => {
    expect(() => buildClaudeSettingsJson([], clonePath, 'implement', [])).toThrow(
      /write_scope must not be empty/,
    );
  });

  it('still throws for an absolute write_scope entry', () => {
    expect(() => buildClaudeSettingsJson(['/abs/path'], clonePath, 'implement', [])).toThrow(
      /must be relative/,
    );
  });

  it('still throws for a write_scope entry containing ".."', () => {
    expect(() => buildClaudeSettingsJson(['../escape'], clonePath, 'implement', [])).toThrow(
      /must not contain "\.\."/,
    );
  });

  it('readFiles: with two absolute files, allow is the clone rule, then one exact-file Read rule per file in order, then Bash; deny is unchanged', () => {
    const file1 = '/home/user/.agent-runs/runs/HO-1000/RUN-00000000-0000-4000-8000-000000000001/validation-evidence.json';
    const file2 = '/home/user/.agent-runs/runs/HO-1000/RUN-00000000-0000-4000-8000-000000000001/implement-response.md';

    const withFiles = JSON.parse(buildClaudeSettingsJson([], clonePath, 'code_review', [file1, file2]));
    expect(withFiles.permissions.allow).toEqual([
      `Read(//${clonePath.slice(1)}/**)`,
      `Read(//${file1.slice(1)})`,
      `Read(//${file2.slice(1)})`,
      'Bash',
    ]);

    const withoutFiles = JSON.parse(buildClaudeSettingsJson([], clonePath, 'code_review', []));
    expect(withFiles.permissions.deny).toEqual(withoutFiles.permissions.deny);
  });

  it('readFiles: a relative entry throws, naming the entry', () => {
    expect(() => buildClaudeSettingsJson([], clonePath, 'code_review', ['relative/file.md'])).toThrow(
      /readFiles entries must be absolute, got "relative\/file\.md"/,
    );
  });

  it('readFiles: an entry containing ".." throws, naming the entry', () => {
    expect(() => buildClaudeSettingsJson([], clonePath, 'code_review', ['/tmp/../escape.md'])).toThrow(
      /readFiles entries must not contain "\.\.": "\/tmp\/\.\.\/escape\.md"/,
    );
  });
});
