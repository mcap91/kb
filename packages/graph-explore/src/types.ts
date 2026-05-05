// ---------------------------------------------------------------------------
// Graph node kinds and wiki prefixes
// ---------------------------------------------------------------------------

/** Kind of node in the graph. */
export type NodeKind = 'code_file' | 'doc_file' | 'wiki_record';

/** Wiki record prefix (manifest-driven only; excludes HO-*). */
export type GraphWikiPrefix = 'WK' | 'IN' | 'DEC' | 'SRC' | 'AREA';

/** Relation types between graph nodes. */
export type EdgeRelation =
  | 'imports'
  | 'repo_path'
  | 'doc'
  | 'depends_on'
  | 'blocks'
  | 'related'
  | 'area'
  | 'initiative'
  | 'markdown_link';

// ---------------------------------------------------------------------------
// Core graph types
// ---------------------------------------------------------------------------

/** A node in the dependency/relationship graph. */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  title?: string;
  prefix?: GraphWikiPrefix;
  exists: boolean;
}

/** A directed edge between two graph nodes. */
export interface GraphEdge {
  source: string;
  target: string;
  relation: EdgeRelation;
}

/** Full graph export written to wiki/.graph.json. */
export interface GraphExport {
  generated_at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  orphans: string[];
}
