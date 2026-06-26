import { Injectable, signal, computed } from '@angular/core';
import { ALL_ARCHETYPES, ALL_SELECTABLE_FIELDS } from './search-state.service';
import {
  GraphMetadataFilter,
  NodeLike,
  defaultMetadata,
  metadataNodeMatches,
  hasActiveMetadataConstraint,
} from './graph-filter.service';

/**
 * Post-construction (in-graph) metadata filter for the OK-Graph view.
 *
 * Unlike {@link GraphFilterService} — which decides which nodes are *added* to the
 * citation graph at build time — this filter runs AFTER clustering and only hides the
 * visibility of already-placed nodes that don't match. It is applied reactively in the
 * view's `laneLayout` computed, so loosening or resetting it brings hidden nodes back
 * (nothing is ever removed from the underlying graph state).
 *
 * It is deliberately independent of the build-time filter and the Retrieved-Results
 * filters: it starts as a no-op (every constraint at its default ⇒ show everything) and
 * {@link resetMetadata} returns it there.
 */
@Injectable({ providedIn: 'root' })
export class GraphPostFilterService {
  /** The in-graph filter constraints. Defaults are a no-op (keep all nodes). */
  readonly metadata = signal<GraphMetadataFilter>(defaultMetadata());

  /** True when any constraint would hide at least some nodes. */
  readonly hasActiveFilter = computed(() => hasActiveMetadataConstraint(this.metadata()));

  updateMetadata(partial: Partial<GraphMetadataFilter>): void {
    this.metadata.update(m => ({ ...m, ...partial }));
  }

  /** Clear the in-graph filter back to a no-op (reveals every node again). */
  resetMetadata(): void {
    this.metadata.set(defaultMetadata());
  }

  toggleArchetype(name: string): void {
    this.metadata.update(m => {
      const next = new Set(m.archetypes);
      next.has(name) ? next.delete(name) : next.add(name);
      return { ...m, archetypes: next };
    });
  }

  setAllArchetypes(on: boolean): void {
    this.updateMetadata({ archetypes: on ? new Set(ALL_ARCHETYPES) : new Set() });
  }

  toggleField(name: string): void {
    this.metadata.update(m => {
      const next = new Set(m.fields);
      next.has(name) ? next.delete(name) : next.add(name);
      return { ...m, fields: next };
    });
  }

  setAllFields(on: boolean): void {
    this.updateMetadata({ fields: on ? new Set(ALL_SELECTABLE_FIELDS) : new Set() });
  }

  /**
   * Predicate over a node's metadata for the CURRENTLY set in-graph constraints.
   * Returns a keep-everything predicate when no constraint is set (no-op filter).
   * `seedScope` controls whether code / peer-reviewed / archetype are enforced
   * (seeds carry that metadata; expanded nodes are passed through).
   */
  nodePredicate(seedScope: boolean): (n: NodeLike) => boolean {
    if (!this.hasActiveFilter()) return () => true;
    const m = this.metadata();
    return (n: NodeLike): boolean => metadataNodeMatches(m, n, seedScope);
  }
}
