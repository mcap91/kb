import type { DashboardData, Phase, PhaseTask, LogEntry, FailureEntry, TaskMatrix } from './schema.js';
import { laneOf, summarize, sourceLatestDate } from './util.js';

export function parseTracker(
  content: string,
  record: {
    id: string; title: string; status: string;
    /** Parent initiative id (WK-0084), if the PLN's own frontmatter declares `initiative:`. */
    parentInitiative?: string;
    /** Whether wiki/dashboard/<parentInitiative>.html existed at generation time. */
    parentDashboardExists?: boolean;
  },
): DashboardData {
  const phases = parsePhaseTable(content);
  const gates = parseGates(content);
  const tasksByPhase = parseTaskMapping(content);

  // Match gate -> phase by slice id (NOT array index -- index-zipping silently
  // misattributes on any reordering) and lift the human label from the gate
  // heading parenthetical: "S1 gate (orchestrate)" -> label "orchestrate".
  for (const g of gates) {
    const phase = phases.find(p => p.id.toLowerCase() === g.sliceId.toLowerCase());
    if (!phase) continue;
    phase.gate = { checked: g.checked, text: g.text };
    if (g.label) phase.label = g.label;
  }

  for (const [phaseId, tasks] of Object.entries(tasksByPhase)) {
    const phase = phases.find(p => p.id === phaseId);
    if (phase) phase.tasks.push(...tasks);
  }

  return {
    record: { ...record, type: 'PLN' },
    summary: summarize(phases.map(p => p.lane)),
    phases,
    workItems: [],
    planItems: [],
    completedLog: parseCompletedLog(content),
    failureLog: parseFailureLog(content),
    taskMatrix: buildTaskMatrix(phases, tasksByPhase),
    dependencyDag: null,
    dataDate: sourceLatestDate(content),
    source: `wiki/plans/${record.id}/execution/tracker.md`,
  };
}

function stationPhrase(desc: string): string {
  const clean = desc
    .replace(/\*\*[^*]*\*\*\.?\s*/g, '')
    .replace(/^(?:pre-)?S\d+:\s*(?:NEW\s+)?/i, '')
    .trim();
  return clean.split(/[(.,:;—]/)[0].trim() || desc.split(/[(.,:;—]/)[0].trim();
}

function buildTaskMatrix(
  phases: Phase[],
  tasksByPhase: Record<string, PhaseTask[]>,
): TaskMatrix | null {
  const columns = phases.map(p => p.id);
  const phaseIndex = new Map(columns.map((id, i) => [id, i]));

  // Invert: taskId → { phaseId → scope, description }
  const taskMap = new Map<string, { desc: string; phases: Map<string, string> }>();
  for (const [phaseId, tasks] of Object.entries(tasksByPhase)) {
    if (!phaseIndex.has(phaseId)) continue;
    for (const t of tasks) {
      let entry = taskMap.get(t.id);
      if (!entry) {
        entry = { desc: t.description, phases: new Map() };
        taskMap.set(t.id, entry);
      }
      entry.phases.set(phaseId, t.scope);
    }
  }

  if (taskMap.size === 0) return null;

  const rows = [...taskMap.entries()]
    .map(([taskId, entry]) => {
      const indices = [...entry.phases.keys()]
        .map(pid => phaseIndex.get(pid)!)
        .filter(i => i !== undefined);
      const firstIdx = Math.min(...indices);
      const lastIdx = Math.max(...indices);

      const cells = columns.map((colId, ci) => {
        const scope = entry.phases.get(colId);
        if (scope !== undefined) return scope || 'NEW';
        if (ci >= firstIdx && ci <= lastIdx) return '·';
        return '';
      });

      return { taskId, station: stationPhrase(entry.desc), cells, firstIdx };
    })
    .sort((a, b) => a.firstIdx - b.firstIdx || a.taskId.localeCompare(b.taskId, undefined, { numeric: true }))
    .map(({ taskId, station, cells }) => ({ taskId, station, cells }));

  return { columns, rows };
}

function extractSection(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^##\\s+${escaped}`, 'mi');
  const match = content.match(regex);
  if (!match || match.index === undefined) return '';
  const start = match.index + match[0].length;
  const next = content.indexOf('\n## ', start);
  return content.slice(start, next === -1 ? undefined : next).trim();
}

function parseMarkdownTable(section: string): Record<string, string>[] {
  const lines = section.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 3) return [];
  const headers = splitRow(lines[0]);
  return lines.slice(2).map(line => {
    const cells = splitRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i] || ''; });
    return row;
  });
}

function splitRow(line: string): string[] {
  return line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
}

function parsePhaseTable(content: string): Phase[] {
  const section = extractSection(content, 'Phase Status Table');
  return parseMarkdownTable(section).map(row => {
    const id = (row['Slice'] || row['Slice (phase)'] || row['Phase'] || Object.values(row)[0] || '').trim();
    const status = (row['Status'] || '').trim();
    return {
      id,
      label: '',
      status,
      lane: laneOf(status, false),
      started: (row['Started'] || '').trim(),
      completed: (row['Completed'] || '').trim(),
      notes: (row['Notes'] || '').trim(),
      gate: null,
      tasks: [],
    };
  });
}

interface GateItem { sliceId: string; label: string; checked: boolean; text: string; }

function parseGates(content: string): GateItem[] {
  const section = extractSection(content, 'Gates');
  const items: GateItem[] = [];
  const regex = /^- \[([ xX])\] (.+)$/gm;
  let match;
  while ((match = regex.exec(section)) !== null) {
    const text = match[2].replace(/\*\*/g, '').trim();
    const m = text.match(/^([sp]\d+)\s+gate\s*(?:\(([^)]+)\))?/i);
    items.push({
      sliceId: m ? m[1] : '',
      label: m && m[2] ? m[2].trim() : '',
      checked: match[1].toLowerCase() === 'x',
      text,
    });
  }
  return items;
}

function parseTaskMapping(content: string): Record<string, PhaseTask[]> {
  const section = extractSection(content, 'Task-to-Phase Mapping');
  const rows = parseMarkdownTable(section);
  const result: Record<string, PhaseTask[]> = {};

  for (const row of rows) {
    const taskId = (row['Task'] || '').trim();
    const phaseRaw = row['Slice'] || row['Slice (phase)'] || row['Phase'] || '';
    const description = (row['Description'] || '').trim();
    const interaction = (row['user_interaction'] || '').trim();

    for (const entry of phaseRaw.split(',').map(e => e.trim())) {
      const scopeMatch = entry.match(/^(.+?)\s*\((.+?)\)\s*$/);
      const phaseId = (scopeMatch ? scopeMatch[1] : entry).trim();
      const scope = scopeMatch ? scopeMatch[2] : '';
      if (!result[phaseId]) result[phaseId] = [];
      result[phaseId].push({ id: taskId, scope, description, interaction });
    }
  }
  return result;
}

function parseCompletedLog(content: string): LogEntry[] {
  const section = extractSection(content, 'Completed Log');
  const tableRows = parseMarkdownTable(section);
  if (tableRows.length > 0) {
    return tableRows.map(row => ({
      date: (row['Date'] || '').trim(),
      task: (row['Task'] || '').trim(),
      summary: (row['Summary'] || '').trim(),
    }));
  }

  // Bullet-list fallback (WK-0082 accepted format): "- 2026-09-06 — WK-0001: summary".
  const entries: LogEntry[] = [];
  const regex = /^- (\d{4}-\d{2}-\d{2})\s*[—-]\s*((?:WK-\d{4}|T\d+)):?\s*(.*)$/gm;
  let match;
  while ((match = regex.exec(section)) !== null) {
    entries.push({ date: match[1], task: match[2], summary: match[3].trim() });
  }
  return entries;
}

function parseFailureLog(content: string): FailureEntry[] {
  const section = extractSection(content, 'Failure Log');
  if (!section) return [];

  // HTML comments (e.g. the template's authoring-guide block) are not failure
  // entries and must be ignored (WK-0082 / bug 5) -- strip them before parsing.
  const cleaned = section.replace(/<!--[\s\S]*?-->/g, '');
  if (!cleaned.trim()) return [];

  const raw = cleaned.split(/^###\s+/m).filter(s => s.trim()).map(part => {
    const nl = part.indexOf('\n');
    return {
      title: (nl === -1 ? part : part.slice(0, nl)).trim(),
      body: nl === -1 ? '' : part.slice(nl).trim(),
    };
  });

  // A failure is resolved when its own text carries a RESOLUTION/RESOLVED marker,
  // OR a later entry supersedes it (the log is chronological; supersession closes
  // the thread). Checking the BODY -- not just the heading -- is the fix for the
  // stale "Issues" card, where a fixed failure kept rendering as active.
  const supersededByLater = raw.map((_, i) =>
    raw.slice(i + 1).some(e => /supersed/i.test(`${e.title}\n${e.body}`)));

  return raw.map((e, i) => {
    const selfResolved = /\bRESOLUTION\b|\bRESOLVED\b/i.test(`${e.title}\n${e.body}`);
    const resolved = selfResolved || supersededByLater[i];
    const resolution = selfResolved
      ? extractResolution(`${e.title}\n${e.body}`)
      : supersededByLater[i] ? 'Superseded by a later entry' : '';
    return { title: e.title, resolved, resolution, body: e.body };
  });
}

function extractResolution(text: string): string {
  for (const line of text.split('\n')) {
    if (/\bRESOLUTION\b|\bRESOLVED\b/i.test(line)) {
      return line
        .replace(/\*\*/g, '')
        .replace(/^[-\s]*\d{4}-\d{2}-\d{2}\s*[—-]\s*/, '')
        .trim();
    }
  }
  return '';
}
