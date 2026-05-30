import { Injectable, signal } from '@angular/core';
import { CitGraphNode } from './citgraph.service';
import { LouvainResult } from '../../features/citgraph/louvain';

/**
 * Bridge between the Cit-Graph tab and the OK-Graph sub-tab. The Cit-Graph view
 * pushes its base nodes and the full Louvain hierarchy here; the OK-Graph view
 * reads it and drills down the cluster tree. Single source of truth so every
 * piece of cit-graph clustering information is available to ok-graph.
 */
@Injectable({ providedIn: 'root' })
export class OkGraphStateService {
  /** Base nodes in Louvain index order (cit-graph layoutNodes[i].data). */
  readonly nodes = signal<CitGraphNode[]>([]);

  /** The Louvain dendrogram that clusters those nodes. */
  readonly louvain = signal<LouvainResult | null>(null);

  readonly hasContent = signal(false);

  setHierarchy(nodes: CitGraphNode[], louvain: LouvainResult): void {
    this.nodes.set(nodes);
    this.louvain.set(louvain);
    this.hasContent.set(nodes.length > 0 && louvain.levels.length > 0);
  }

  clear(): void {
    this.nodes.set([]);
    this.louvain.set(null);
    this.hasContent.set(false);
  }
}
