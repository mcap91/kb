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

/** One stage of a chain: a free name, an optional gate, work item ids in build order. */
export interface ChainGroup {
  name: string;
  gate?: string;
  ids: string[];
}

/**
 * A chain: stages in build order. A critical path is a chain across
 * initiatives; an initiative section is the chain of one initiative.
 */
export interface Chain {
  heading: string;
  groups: ChainGroup[];
}

export interface ChainInitiativeSection extends Chain {
  id: string;
}

export interface ChainDocData {
  updated?: string;
  paths: Chain[];
  initiatives: Map<string, ChainInitiativeSection>;
}

/** Every work item id of a chain, in build order, each once. */
export function chainIds(chain: Chain): string[] {
  const out: string[] = [];
  for (const group of chain.groups) {
    for (const id of group.ids) if (!out.includes(id)) out.push(id);
  }
  return out;
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

  type Section = { kind: 'chain'; chain: Chain; group?: ChainGroup } | { kind: 'free' } | { kind: 'discard' };

  let current: Section | undefined;
  let pendingGate: { group: ChainGroup; parts: string[] } | undefined;
  const seenInitiatives = new Set<string>();

  const flushGate = (): void => {
    if (!pendingGate) return;
    pendingGate.group.gate = pendingGate.parts.join(' ').trim();
    pendingGate = undefined;
  };

  const ensureGroup = (section: { chain: Chain; group?: ChainGroup }): ChainGroup => {
    if (!section.group) {
      section.group = { name: '', ids: [] };
      section.chain.groups.push(section.group);
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
        const chain: Chain = { heading: name, groups: [] };
        data.paths.push(chain);
        current = { kind: 'chain', chain };
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
            const section: ChainInitiativeSection = { id, heading: name, groups: [] };
            data.initiatives.set(id, section);
            current = { kind: 'chain', chain: section };
          }
        } else {
          current = { kind: 'free' };
        }
      }
      continue;
    }

    if (isH3(line)) {
      const name = headingText(line);
      if (current?.kind === 'chain') {
        const group: ChainGroup = { name, ids: [] };
        current.group = group;
        current.chain.groups.push(group);
      } else {
        current = { kind: 'free' };
      }
      continue;
    }

    if (isGateLine(line)) {
      if (current?.kind !== 'chain') continue; // a Gate: line outside a chain is free text
      const group = ensureGroup(current);
      if (group.gate !== undefined) {
        problems.push({
          line: lineNo,
          message: 'stage has a second Gate: line; the first is used',
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

    if (current?.kind === 'chain') {
      const group = ensureGroup(current);
      const id = idAtStart(item, opts.workPrefix);
      if (id === undefined) continue; // a list item with no work item id is free text
      if (!group.ids.includes(id)) group.ids.push(id);
      if (!opts.workItemIds.has(id)) {
        problems.push({ line: lineNo, message: `${id} has no record` });
      }
      continue;
    }
  }

  flushGate();
  return { data, problems };
}
