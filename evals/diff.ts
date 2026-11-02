/**
 * Minimal unified `git diff` text parser (WK-0237 slice B1a). The per-run
 * pipeline (slice B1b) saves `git -C test_kb diff <seeded-commit>` text;
 * these checks are pure functions over that text, so parsing stays here
 * rather than shelling out to git.
 */

export const SEARCH_INDEX_PATH = 'wiki/.search-index.json';

export interface DiffFileChange {
  /** The post-change (`b/`) path. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Added line content, with the leading `+` stripped. */
  addedLines: string[];
  /** Removed line content, with the leading `-` stripped. */
  removedLines: string[];
}

const DIFF_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** Parses unified `git diff` text into one `DiffFileChange` per file header. */
export function parseGitDiff(diffText: string): DiffFileChange[] {
  if (diffText.trim().length === 0) return [];

  const changes: DiffFileChange[] = [];
  let current: DiffFileChange | null = null;

  for (const line of diffText.split('\n')) {
    const header = DIFF_HEADER_RE.exec(line);
    if (header) {
      if (current) changes.push(current);
      current = { path: header[2], status: 'modified', addedLines: [], removedLines: [] };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      // file-level markers, not content
    } else if (line.startsWith('+')) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.removedLines.push(line.slice(1));
    }
  }
  if (current) changes.push(current);

  return changes;
}

/** True for `wiki`, `wiki/...`, or a path with `/wiki/` anywhere in it (handles an absolute jail path prefix). */
export function isUnderWiki(path: string): boolean {
  return path === 'wiki' || path.startsWith('wiki/') || path.includes('/wiki/');
}

/** Changed paths outside `wiki/`, ignoring the rebuilt search index (WK-0237 Acceptance: "ignoring the rebuilt index"). */
export function changedPathsOutsideWiki(changes: DiffFileChange[]): string[] {
  return changes.map((c) => c.path).filter((p) => p !== SEARCH_INDEX_PATH && !isUnderWiki(p));
}
