/**
 * Pure reader for the `chain.md` status doc.
 *
 * Text in; parsed data and a list of problems out. It never writes, never
 * prints and does not depend on the generator, so lint can reuse it.
 */

export interface ChainDocProblem {
  /** 1-based line number in the source text. */
  line: number;
  message: string;
}

export interface ChainPathGroup {
  name: string;
  gate?: string;
  ids: string[];
}

export interface ChainPath {
  heading: string;
  groups: ChainPathGroup[];
}

export interface ChainInitiativeSection {
  id: string;
  heading: string;
  /** Queue ids in file order, deduped at their first place. */
  queue: string[];
  /** Whether at least one group heading starts with "In Progress" or "To Do". */
  hasQueue: boolean;
}

export interface ChainDocData {
  updated?: string;
  paths: ChainPath[];
  initiatives: Map<string, ChainInitiativeSection>;
}

export interface ChainDocParseOpts {
  /** Work item prefix from the manifest, e.g. `WK`. */
  workPrefix: string;
  /** Initiative prefix from the manifest, e.g. `IN`. */
  initiativePrefix: string;
  /** Known work item ids, for the "has no record" problems. */
  workItemIds: Set<string>;
  /** Known initiative ids, for the "has no record" problems. */
  initiativeIds: Set<string>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The full id at the start of `text`, when it has the prefix shape. */
function idAtStart(text: string, prefix: string): string | undefined {
  const match = new RegExp(`^${escapeRegExp(prefix)}-\\d+`).exec(text.trimStart());
  return match ? match[0] : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The `updated` value from the leading frontmatter block, if any. */
function readUpdated(lines: string[]): string | undefined {
  if ((lines[0] ?? '').trim() !== '---') return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return undefined;
  for (let i = 1; i < end; i++) {
    const match = /^updated\s*:\s*(.*)$/.exec(lines[i]);
    if (match) return unquote(match[1]);
  }
  return undefined;
}

function isH2(line: string): boolean {
  return /^##\s/.test(line) && !/^###/.test(line);
}

function isH3(line: string): boolean {
  return /^###\s/.test(line) && !/^####/.test(line);
}

function isHeading(line: string): boolean {
  return isH2(line) || isH3(line);
}

function isListItem(line: string): boolean {
  return /^(?:-\s+|\d+\.\s+)/.test(line);
}

/** Text after a list marker, or `null` when the line is not a top-level list item. */
function listItemText(line: string): string | null {
  const match = /^(?:-\s+|\d+\.\s+)(.*)$/.exec(line);
  return match ? match[1] : null;
}

function isGateLine(line: string): boolean {
  return /^Gate:/.test(line);
}

function gateText(line: string): string {
  return line.slice('Gate:'.length).trim();
}

function headingText(line: string): string {
  return line.replace(/^#{2,6}\s+/, '').trim();
}

function startsQueueGroup(name: string): boolean {
  return name.startsWith('In Progress') || name.startsWith('To Do');
}

/**
 * Parse a `chain.md` text.
 *
 * `undefined` (a missing file) yields empty data and no problems. The function
 * never throws.
 */
export function readChainDoc(
  text: string | undefined,
  opts: ChainDocParseOpts,
): { data: ChainDocData; problems: ChainDocProblem[] } {
  const data: ChainDocData = { paths: [], initiatives: new Map() };
  const problems: ChainDocProblem[] = [];

  if (text === undefined) return { data, problems };

  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const updated = readUpdated(lines);
  data.updated = updated;
  if (updated === undefined || !DATE_RE.test(updated)) {
    problems.push({ line: 1, message: 'chain.md updated is missing or not a date' });
  }

  type Section =
    | { kind: 'path'; path: ChainPath; group?: ChainPathGroup }
    | { kind: 'initiative'; section: ChainInitiativeSection; group?: { queue: boolean } }
    | { kind: 'free' }
    | { kind: 'discard' };

  let current: Section | undefined;
  let pendingGate: { group: ChainPathGroup; parts: string[] } | undefined;
  const seenInitiatives = new Set<string>();

  const flushGate = (): void => {
    if (!pendingGate) return;
    pendingGate.group.gate = pendingGate.parts.join(' ').trim();
    pendingGate = undefined;
  };

  const ensurePathGroup = (section: { path: ChainPath; group?: ChainPathGroup }): ChainPathGroup => {
    if (!section.group) {
      section.group = { name: '', ids: [] };
      section.path.groups.push(section.group);
    }
    return section.group;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNo = i + 1;

    const boundary = trimmed === '' || isHeading(line) || isListItem(line) || isGateLine(line);
    if (pendingGate && boundary) flushGate();

    if (trimmed === '') continue;

    if (pendingGate && !boundary) {
      pendingGate.parts.push(trimmed);
      continue;
    }

    if (isH2(line)) {
      const name = headingText(line);
      if (name.startsWith('Critical path')) {
        const path: ChainPath = { heading: name, groups: [] };
        data.paths.push(path);
        current = { kind: 'path', path };
      } else {
        const id = idAtStart(name, opts.initiativePrefix);
        if (id !== undefined) {
          if (seenInitiatives.has(id)) {
            problems.push({
              line: lineNo,
              message: `initiative ${id} has more than one section; the first is used`,
            });
            current = { kind: 'discard' };
          } else {
            seenInitiatives.add(id);
            if (!opts.initiativeIds.has(id)) {
              problems.push({
                line: lineNo,
                message: `initiative heading names ${id}, which has no record`,
              });
            }
            const section: ChainInitiativeSection = {
              id,
              heading: name,
              queue: [],
              hasQueue: false,
            };
            data.initiatives.set(id, section);
            current = { kind: 'initiative', section };
          }
        } else {
          current = { kind: 'free' };
        }
      }
      continue;
    }

    if (isH3(line)) {
      const name = headingText(line);
      if (current?.kind === 'path') {
        const group: ChainPathGroup = { name, ids: [] };
        current.group = group;
        current.path.groups.push(group);
      } else if (current?.kind === 'initiative') {
        const queue = startsQueueGroup(name);
        if (queue) current.section.hasQueue = true;
        current.group = { queue };
      } else {
        current = { kind: 'free' };
      }
      continue;
    }

    if (isGateLine(line)) {
      if (current?.kind !== 'path') continue; // a Gate: line outside a critical path is free text
      const group = ensurePathGroup(current);
      if (group.gate !== undefined) {
        problems.push({
          line: lineNo,
          message: 'critical path group has a second Gate: line; the first is used',
        });
        continue;
      }
      group.gate = '';
      const rest = gateText(line);
      pendingGate = { group, parts: rest ? [rest] : [] };
      continue;
    }

    const item = listItemText(line);
    if (item === null) continue;

    if (current?.kind === 'path') {
      const group = ensurePathGroup(current);
      const id = idAtStart(item, opts.workPrefix);
      if (id === undefined) continue; // free text in a critical path
      if (!group.ids.includes(id)) group.ids.push(id);
      if (!opts.workItemIds.has(id)) {
        problems.push({ line: lineNo, message: `${id} has no record` });
      }
      continue;
    }

    if (current?.kind === 'initiative') {
      if (!current.group?.queue) continue; // free text under any other heading
      const id = idAtStart(item, opts.workPrefix);
      if (id === undefined) {
        problems.push({
          line: lineNo,
          message: 'list item in a queue group does not start with a work item id',
        });
        continue;
      }
      if (!current.section.queue.includes(id)) current.section.queue.push(id);
      if (!opts.workItemIds.has(id)) {
        problems.push({ line: lineNo, message: `${id} has no record` });
      }
      continue;
    }
  }

  flushGate();
  return { data, problems };
}
