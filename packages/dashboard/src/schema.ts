// Deterministic dashboard data contract.
//
// The pipeline is a pure function: source files -> parsers -> this JSON -> one
// template string-replace. No wall-clock, no network, no LLM. `dataDate` is
// derived from the source content (latest date found), so identical input yields
// byte-identical output -- see dashboard.test.ts.

export type Lane = 'done' | 'in_progress' | 'blocked' | 'queued';

export interface DashboardData {
  record: RecordInfo;
  summary: Summary;
  phases: Phase[];
  workItems: WorkItem[];
  completedLog: LogEntry[];
  failureLog: FailureEntry[];
  /** Latest date (YYYY-MM-DD) found in the source; '' if none. Deterministic. */
  dataDate: string;
  /** Human-readable source path the dashboard was built from. */
  source: string;
}

export interface RecordInfo {
  id: string;
  title: string;
  status: string;
  type: 'PLN' | 'IN' | 'WK-set';
}

/** Lane counts, computed deterministically from phases (PLN) or workItems (IN/WK). */
export interface Summary {
  done: number;
  inProgress: number;
  blocked: number;
  queued: number;
  total: number;
}

export interface Phase {
  /** Slice id as authored, e.g. 'S0', 'pre-S0'. */
  id: string;
  /** Human label derived from the gate heading parenthetical, e.g. 'skeleton'. '' if none. */
  label: string;
  /** Raw status text from the tracker Phase Status Table. */
  status: string;
  /** Normalized lane for coloring/bucketing (single source of truth). */
  lane: Lane;
  started: string;
  completed: string;
  /** Raw agent prose. Demoted to click-to-expand detail, never the scan path. */
  notes: string;
  gate: { checked: boolean; text: string } | null;
  tasks: PhaseTask[];
}

export interface PhaseTask {
  id: string;
  scope: string;
  description: string;
  interaction: string;
}

export interface WorkItem {
  id: string;
  title: string;
  status: string;
  lane: Lane;
  priority: string;
  /** Unmet dependencies resolved to title+status -- the deterministic "why blocked". */
  blockedBy: Dependency[];
}

export interface Dependency {
  id: string;
  title: string;
  status: string;
  met: boolean;
}

export interface LogEntry {
  date: string;
  task: string;
  summary: string;
}

export interface FailureEntry {
  title: string;
  resolved: boolean;
  /** Extracted resolution note (why/how it was resolved); '' while active. */
  resolution: string;
  /** Raw entry body. Demoted to click-to-expand detail. */
  body: string;
}
