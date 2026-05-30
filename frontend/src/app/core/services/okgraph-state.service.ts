import { Injectable, signal } from '@angular/core';
import { CitGraphNode } from './citgraph.service';
import { LouvainResult } from '../../features/citgraph/louvain';
import { LayoutEdge } from '../../features/graph/graph-layout';
import { Paper } from '../models/paper.model';

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

/**
 * Bridge between the Cit-Graph tab and the OK-Graph sub-tab, and the persistent
 * home for the OK-Graph's exploration state. The Cit-Graph pushes the base nodes
 * + Louvain hierarchy here; the OK-Graph view reads it and stores its placed
 * nodes / links here too, so expansions survive leaving and returning to the
 * sub-tab (the component is re-created on navigation, this singleton is not).
 */
@Injectable({ providedIn: 'root' })
export class OkGraphStateService {
  /** Base nodes in Louvain index order (cit-graph layoutNodes[i].data). */
  readonly nodes = signal<CitGraphNode[]>([]);

  /** The Louvain dendrogram that clusters those nodes. */
  readonly louvain = signal<LouvainResult | null>(null);

  readonly hasContent = signal(false);

  /** Nodes currently on the OK-Graph canvas and the manual links between them. */
  readonly placed = signal<PlacedNode[]>([]);
  readonly links = signal<LayoutEdge[]>([]);

  setHierarchy(nodes: CitGraphNode[], louvain: LouvainResult): void {
    this.nodes.set(nodes);
    this.louvain.set(louvain);
    this.hasContent.set(nodes.length > 0 && louvain.levels.length > 0);
    // New dataset → drop any previous exploration; the view re-seeds top reps.
    this.placed.set([]);
    this.links.set([]);
  }

  clear(): void {
    this.nodes.set([]);
    this.louvain.set(null);
    this.hasContent.set(false);
    this.placed.set([]);
    this.links.set([]);
  }
}
