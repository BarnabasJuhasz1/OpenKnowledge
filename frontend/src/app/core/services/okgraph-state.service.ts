import { Injectable, signal } from '@angular/core';
import { CitGraphNode, CitGraphEdge } from './citgraph.service';
import { louvain, LouvainResult } from '../../features/citgraph/louvain';
import { LayoutEdge } from '../../features/okgraph/graph-layout';
import { Paper } from '../models/paper.model';
import { compileNodePredicate } from '../../shared/utils/boolean-query';
// Type-only: the snapshot payload shape lives with the snapshot service. Erased
// at runtime, so it doesn't create an import cycle (graph-snapshot → this).
import type { SnapshotGraph } from './graph-snapshot.service';

/** A node placed on the OK-Graph: the representative of a Louvain cluster. */
export interface PlacedNode {
  id: string;          // representative paper_id
  repIndex: number;    // base node index of the representative
  level: number;       // Louvain hierarchy index the cluster lives at (-1 = leaf paper)
  community: number;   // community id at that level (or base index for a leaf)
  topCluster: number;  // highest-level community this node belongs to (its lane)
  paper: Paper;
  clusterSize: number; // number of base papers in the cluster
}

/** Everything the Cit-Graph hands over so the OK-Graph can (re-)cluster. */
export interface HierarchyPayload {
  nodes: CitGraphNode[];      // base nodes in Louvain index order
  louvain: LouvainResult;     // hierarchy over those nodes (already prefiltered if `prefiltered`)
  edges: CitGraphEdge[];      // citation edges (paper_id form), used to re-cluster a filtered subset
  resolution: number;         // Louvain params, so a re-cluster matches the original run
  maxLevels: number;
  keywords: string[];         // flattened keyword query (legacy; kept for any remaining consumers)
  booleanQuery: string;       // boolean title+abstract query used for the keyword filter
  seedId: string;             // origin paper — always kept so the filter matches the Cit-Graph stage
  prefiltered: boolean;       // true → the Cit-Graph already dropped non-matching papers
  initialSeedIds?: string[];  // paper IDs initially selected to construct this graph
  directionalSplit?: boolean; // true → graph built with the v2 "direction-pure cones" construction
  hideIntermediates?: boolean; // true → 'all' mode: cluster the full k-hop graph but render only retrieved papers (hop 0); hop>0 nodes are hidden
}

/**
 * Bridge between the Cit-Graph tab and the OK-Graph sub-tab, and the persistent
 * home for the OK-Graph's exploration state. The Cit-Graph pushes the base nodes
 * + Louvain hierarchy here; the OK-Graph view reads it and stores its placed
 * nodes / links here too, so expansions survive leaving and returning to the
 * sub-tab (the component is re-created on navigation, this singleton is not).
 */
@Injectable({ providedIn: 'root' })
export class OkGraphStateService {
  /** Base nodes in Louvain index order — reflects the *active* filter state. */
  readonly nodes = signal<CitGraphNode[]>([]);

  /** The Louvain dendrogram that clusters the active nodes. */
  readonly louvain = signal<LouvainResult | null>(null);

  readonly hasContent = signal(false);

  /** Nodes currently on the OK-Graph canvas and the manual links between them. */
  readonly placed = signal<PlacedNode[]>([]);
  readonly links = signal<LayoutEdge[]>([]);

  /**
   * Paper ids excluded from display: NON-DISPLAYABLE base nodes. This covers both
   * (a) papers the user permanently removed (individual nodes or whole
   * (sub)clusters), and (b) hidden intermediate connector papers in 'all' mode
   * (`hideIntermediates` — they cluster but never render). Exclusion is
   * irreversible within a graph: candidate generation, representative selection
   * and member counts all skip these, so no expansion or re-seed brings them
   * back. Reset on a new graph (`setHierarchy`) — then re-seeded with the hidden
   * intermediates when `hideIntermediates` is set — or `clear()`; kept across
   * `setFilter()` re-clusters since paper ids are stable.
   */
  readonly removedIds = signal<Set<string>>(new Set());

  /**
   * True when the current graph was built with the full k-hop graph as the
   * clustering substrate but only the retrieved papers (hop 0) are rendered
   * ('all' mode). The hidden intermediate nodes (hop > 0) are seeded into
   * `removedIds` so the view excludes them everywhere; this flag lets the summary
   * service filter cluster members to retrieved-only.
   */
  readonly hideIntermediates = signal(false);

  /** Permanently exclude `ids` from the graph (additive). */
  markRemoved(ids: Iterable<string>): void {
    this.removedIds.update(cur => {
      const next = new Set(cur);
      for (const id of ids) next.add(id);
      return next;
    });
  }

  /** Open/collapsed state of the right-side details panel. Defaults to true (collapsed) when no paper selected. */
  readonly panelCollapsed = signal(true);
  /** User preference tracking if the panel should automatically open on selecting a paper. Defaults to true. */
  readonly autoOpenEnabled = signal(true);

  /** Whether the keyword filter is currently applied on the OK-Graph. */
  readonly filterActive = signal(false);
  /** True when the Cit-Graph prefiltered: the OK-Graph filter is then locked on. */
  readonly prefiltered = signal(false);
  /** Flattened keyword query; empty → nothing to filter (toggle disabled). */
  readonly keywords = signal<string[]>([]);
  /** Boolean title+abstract query backing the keyword filter; empty → nothing to filter. */
  readonly booleanQuery = signal<string>('');

  /** Paper IDs initially selected for constructing this graph. */
  readonly initialSeedIds = signal<Set<string>>(new Set());

  /**
   * True when the displayed graph was built with the v2 "direction-pure cones"
   * construction. Gates v2-only layout behaviour (e.g. the seed-year column
   * split), since the live `graphVersion` toggle reflects the *next* build, not
   * the graph currently on screen.
   */
  readonly directionalSplit = signal(false);

  /**
   * The raw citation graph (base nodes + edges) the current hierarchy was built
   * from, plus the Louvain resolution used. Shared so the Clustering (Cit-Graph)
   * page can reflect a graph that was built+clustered in the background from the
   * OK-Graph page. Null until the first exploration.
   */
  readonly rawGraph = signal<{
    nodes: CitGraphNode[];
    edges: CitGraphEdge[];
    seedId: string;
    resolution: number;
    maxLevels: number;
  } | null>(null);

  // Originals kept so the filter can be toggled off (restore) or on (re-cluster).
  private allNodes: CitGraphNode[] = [];
  private allEdges: CitGraphEdge[] = [];
  private originalLouvain: LouvainResult | null = null;
  private resolution = 1;
  private maxLevels = 10;
  private seedId = '';

  setHierarchy(p: HierarchyPayload): void {
    this.allNodes = p.nodes;
    this.allEdges = p.edges;
    this.originalLouvain = p.louvain;
    this.resolution = p.resolution;
    this.maxLevels = p.maxLevels;
    this.seedId = p.seedId;
    this.keywords.set(p.keywords);
    this.booleanQuery.set(p.booleanQuery);
    this.prefiltered.set(p.prefiltered);
    // If the Cit-Graph already prefiltered, the OK-Graph filter starts on and
    // cannot be turned off (the discarded papers were never sent).
    this.filterActive.set(p.prefiltered);

    if (p.initialSeedIds) {
      this.initialSeedIds.set(new Set(p.initialSeedIds));
    } else {
      this.initialSeedIds.set(new Set(p.seedId ? [p.seedId] : []));
    }

    this.directionalSplit.set(!!p.directionalSplit);
    this.hideIntermediates.set(!!p.hideIntermediates);

    this.nodes.set(p.nodes);
    this.louvain.set(p.louvain);
    this.rawGraph.set({
      nodes: p.nodes,
      edges: p.edges,
      seedId: p.seedId,
      resolution: p.resolution,
      maxLevels: p.maxLevels,
    });
    this.hasContent.set(p.nodes.length > 0 && p.louvain.levels.length > 0);
    // New dataset → drop any previous exploration; the view re-seeds top reps.
    this.placed.set([]);
    this.links.set([]);
    // Reset removals, then (in 'all' mode) seed the hidden intermediate connector
    // papers (hop > 0) so the view excludes them everywhere it already excludes
    // user-removed papers. The full graph is still clustered/summarized; only the
    // retrieved papers (hop 0) are rendered.
    this.removedIds.set(
      p.hideIntermediates
        ? new Set(p.nodes.filter(n => n.hop > 0).map(n => n.paper_id))
        : new Set(),
    );
  }

  /** Can the OK-Graph filter be toggled at all? */
  canToggleFilter(): boolean {
    return !this.prefiltered() && this.booleanQuery().trim().length > 0;
  }

  /**
   * Turn the OK-Graph keyword filter on/off. When on, the hierarchy is recomputed
   * over only the matching papers — as if the rest were removed from the graph
   * entirely. When off, the original (unfiltered) hierarchy is restored. Locked
   * on when the Cit-Graph already prefiltered.
   */
  setFilter(on: boolean): void {
    if (this.prefiltered()) return;                       // locked on
    if (!this.booleanQuery().trim().length) return;       // nothing to filter
    if (on === this.filterActive()) return;
    this.filterActive.set(on);

    if (!on) {
      // Restore the full graph.
      this.nodes.set(this.allNodes);
      this.louvain.set(this.originalLouvain);
    } else {
      // Re-cluster the matching subset only, using the same boolean engine as search.
      const pred = compileNodePredicate(this.booleanQuery());
      const kept = this.allNodes.filter(
        n => n.paper_id === this.seedId || pred(n),
      );
      const indexOf = new Map(kept.map((n, i) => [n.paper_id, i]));
      const edges = this.allEdges
        .map(e => ({ source: indexOf.get(e.source) ?? -1, target: indexOf.get(e.target) ?? -1 }))
        .filter(e => e.source >= 0 && e.target >= 0);
      const result = louvain(kept.length, edges, {
        resolution: this.resolution,
        maxLevels: this.maxLevels,
      });
      this.nodes.set(kept);
      this.louvain.set(result);
    }

    // Force the view to re-seed top-level representatives for the new structure.
    this.placed.set([]);
    this.links.set([]);
  }

  /**
   * Serialize the current base graph for a snapshot, or null when nothing is
   * built. Pairs `rawGraph()` (nodes/edges/seed/Louvain params) with the filter
   * context so a load can reproduce the identical Louvain run and filter state.
   */
  exportSnapshotGraph(): SnapshotGraph | null {
    const raw = this.rawGraph();
    if (!raw || !raw.nodes.length) return null;
    return {
      nodes: raw.nodes,
      edges: raw.edges,
      seedId: raw.seedId,
      resolution: raw.resolution,
      maxLevels: raw.maxLevels,
      booleanQuery: this.booleanQuery(),
      keywords: this.keywords(),
      prefiltered: this.prefiltered(),
      initialSeedIds: [...this.initialSeedIds()],
      directionalSplit: this.directionalSplit(),
      hideIntermediates: this.hideIntermediates(),
    };
  }

  /**
   * Reconstruct the base graph from a loaded snapshot (subtask 04). Recomputes
   * the (deterministic) Louvain hierarchy from the saved nodes/edges + params and
   * runs it through `setHierarchy` with the saved filter context, so a load lands
   * on exactly the same base view the snapshot was taken from (placed/links/
   * removedIds reset). The summary store MUST be hydrated first
   * (`ClusterSummaryService.hydrate`) so the re-summarization effect no-ops when
   * `rawGraph` updates here.
   */
  loadSnapshotGraph(graph: SnapshotGraph): void {
    const result = this.recluster(graph.nodes, graph.edges, graph.resolution, graph.maxLevels);
    this.setHierarchy({
      nodes: graph.nodes,
      louvain: result,
      edges: graph.edges,
      resolution: graph.resolution,
      maxLevels: graph.maxLevels,
      keywords: graph.keywords,
      booleanQuery: graph.booleanQuery,
      seedId: graph.seedId,
      prefiltered: graph.prefiltered,
      initialSeedIds: graph.initialSeedIds,
      directionalSplit: graph.directionalSplit,
      hideIntermediates: graph.hideIntermediates,
    });
  }

  /** Run Louvain over the full graph (paper-id edges → index edges). Same
   *  deterministic mapping the Cit-Graph stage uses, so the hierarchy reproduces
   *  the community ids the summaries were keyed by. */
  private recluster(
    nodes: CitGraphNode[],
    edges: CitGraphEdge[],
    resolution: number,
    maxLevels: number,
  ): LouvainResult {
    const indexOf = new Map(nodes.map((n, i) => [n.paper_id, i]));
    const mapped = edges
      .map(e => ({ source: indexOf.get(e.source) ?? -1, target: indexOf.get(e.target) ?? -1 }))
      .filter(e => e.source >= 0 && e.target >= 0);
    return louvain(nodes.length, mapped, { resolution, maxLevels });
  }

  clear(): void {
    this.nodes.set([]);
    this.louvain.set(null);
    this.hasContent.set(false);
    this.placed.set([]);
    this.links.set([]);
    this.removedIds.set(new Set());
    this.panelCollapsed.set(true);
    this.autoOpenEnabled.set(true);
    this.filterActive.set(false);
    this.prefiltered.set(false);
    this.keywords.set([]);
    this.booleanQuery.set('');
    this.initialSeedIds.set(new Set());
    this.directionalSplit.set(false);
    this.hideIntermediates.set(false);
    this.rawGraph.set(null);
    this.allNodes = [];
    this.allEdges = [];
    this.originalLouvain = null;
    this.seedId = '';
  }
}
