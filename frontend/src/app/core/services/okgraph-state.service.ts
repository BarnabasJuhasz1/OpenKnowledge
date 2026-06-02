import { Injectable, signal } from '@angular/core';
import { CitGraphNode, CitGraphEdge } from './citgraph.service';
import { louvain, LouvainResult } from '../../features/citgraph/louvain';
import { LayoutEdge } from '../../features/okgraph/graph-layout';
import { Paper } from '../models/paper.model';
import { matchesNodeKeywords } from '../../shared/utils/keyword-match';

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
  keywords: string[];         // flattened keyword query for title+abstract matching
  seedId: string;             // origin paper — always kept so the filter matches the Cit-Graph stage
  prefiltered: boolean;       // true → the Cit-Graph already dropped non-matching papers
  initialSeedIds?: string[];  // paper IDs initially selected to construct this graph
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

  /** Paper IDs initially selected for constructing this graph. */
  readonly initialSeedIds = signal<Set<string>>(new Set());

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
    this.prefiltered.set(p.prefiltered);
    // If the Cit-Graph already prefiltered, the OK-Graph filter starts on and
    // cannot be turned off (the discarded papers were never sent).
    this.filterActive.set(p.prefiltered);

    if (p.initialSeedIds) {
      this.initialSeedIds.set(new Set(p.initialSeedIds));
    } else {
      this.initialSeedIds.set(new Set(p.seedId ? [p.seedId] : []));
    }

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
  }

  /** Can the OK-Graph filter be toggled at all? */
  canToggleFilter(): boolean {
    return !this.prefiltered() && this.keywords().length > 0;
  }

  /**
   * Turn the OK-Graph keyword filter on/off. When on, the hierarchy is recomputed
   * over only the matching papers — as if the rest were removed from the graph
   * entirely. When off, the original (unfiltered) hierarchy is restored. Locked
   * on when the Cit-Graph already prefiltered.
   */
  setFilter(on: boolean): void {
    if (this.prefiltered()) return;           // locked on
    if (!this.keywords().length) return;      // nothing to filter
    if (on === this.filterActive()) return;
    this.filterActive.set(on);

    if (!on) {
      // Restore the full graph.
      this.nodes.set(this.allNodes);
      this.louvain.set(this.originalLouvain);
    } else {
      // Re-cluster the matching subset only.
      const kw = this.keywords();
      const kept = this.allNodes.filter(
        n => n.paper_id === this.seedId || matchesNodeKeywords(n, kw),
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

  clear(): void {
    this.nodes.set([]);
    this.louvain.set(null);
    this.hasContent.set(false);
    this.placed.set([]);
    this.links.set([]);
    this.panelCollapsed.set(true);
    this.autoOpenEnabled.set(true);
    this.filterActive.set(false);
    this.prefiltered.set(false);
    this.keywords.set([]);
    this.initialSeedIds.set(new Set());
    this.rawGraph.set(null);
    this.allNodes = [];
    this.allEdges = [];
    this.originalLouvain = null;
    this.seedId = '';
  }
}
