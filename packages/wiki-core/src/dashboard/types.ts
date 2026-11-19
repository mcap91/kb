/** The parsed record shape the dashboard pages read (rule R7). */
export interface DashboardRecord {
  id: string;
  /** Manifest prefix of the record type, e.g. `WK`. */
  prefix: string;
  /** Manifest type key, e.g. `issue`. */
  typeLabel: string;
  title: string;
  status: string;
  priority?: string;
  updated?: string;
  initiative?: string;
  depends_on: string[];
  blocks: string[];
  related: string[];
  tags: string[];
  /** The record's own `type` frontmatter field (work items). */
  itemType?: string;
  absPath: string;
  relPath: string;
  body: string;
  data: Record<string, unknown>;
}

/** The folder and page count reported by `generate`. */
export interface DashboardSummary {
  dir: string;
  pages: number;
}
