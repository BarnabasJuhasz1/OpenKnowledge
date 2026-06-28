import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, map, tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CitGraphNode, CitGraphEdge } from './citgraph.service';
import { OkGraphStateService } from './okgraph-state.service';
import { ClusterSummaryService } from './cluster-summary.service';
import { ProjectContextService } from './project-context.service';

/**
 * The serializable base-graph payload (must match the backend `graph_json`
 * shape, subtask 02). Mirrors `OkGraphStateService.rawGraph()` plus the filter
 * context needed to reproduce the exact same Louvain run on load.
 */
export interface SnapshotGraph {
  nodes: CitGraphNode[];
  edges: CitGraphEdge[];
  seedId: string;
  resolution: number;
  maxLevels: number;
  booleanQuery: string;
  keywords: string[];
  prefiltered: boolean;
  initialSeedIds: string[];
  directionalSplit: boolean;
  /** 'all' mode: full k-hop graph was clustered but only retrieved papers (hop 0)
   *  render. Optional for backward compatibility with snapshots saved before it. */
  hideIntermediates?: boolean;
}

/** One cluster summary, keyed by its Louvain (level, community). */
export interface SnapshotSummary {
  level: number;
  community: number;
  title: string;
  summary: string;
  bullets: string[];
}

/** List/create/rename metadata — never carries the blobs. */
export interface SnapshotMeta {
  id: number;
  name: string;
  seedId: string | null;
  nodeCount: number;
  clusterCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The load payload — metadata plus the deserialized blobs. */
export interface SnapshotDetail extends SnapshotMeta {
  graph: SnapshotGraph;
  summaries: SnapshotSummary[];
}

/** Backend wire shapes (snake_case) before mapping to the camelCase domain. */
interface ApiSnapshotMeta {
  id: number;
  name: string;
  seed_id: string | null;
  node_count: number | null;
  cluster_count: number | null;
  created_at: string;
  updated_at: string;
}
interface ApiSnapshotDetail extends ApiSnapshotMeta {
  graph: SnapshotGraph;
  summaries: SnapshotSummary[];
}

/** Why a snapshot operation failed, so the UI can react specifically (e.g. the
 *  cap → "delete one first", a name clash → "pick another name"). */
export type SnapshotErrorKind =
  | 'limit'
  | 'duplicate-name'
  | 'no-graph'
  | 'no-project'
  | 'other';

export class SnapshotError extends Error {
  constructor(readonly kind: SnapshotErrorKind, message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function toMeta(a: ApiSnapshotMeta): SnapshotMeta {
  return {
    id: a.id,
    name: a.name,
    seedId: a.seed_id,
    nodeCount: a.node_count ?? 0,
    clusterCount: a.cluster_count ?? 0,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

function toDetail(a: ApiSnapshotDetail): SnapshotDetail {
  return { ...toMeta(a), graph: a.graph, summaries: a.summaries };
}

/**
 * HTTP client for OK-Graph snapshots, plus the serialize step that turns the
 * live in-memory graph state into the wire payload. Ownership is **not** checked
 * here — it follows project access on the backend (a guest saves under the
 * null-bucket project; the session cookie rides every request via the
 * interceptor). The deserialize / hydrate step (rebuilding the live state from a
 * loaded snapshot) lives in subtask 04.
 */
@Injectable({ providedIn: 'root' })
export class GraphSnapshotService {
  private readonly http = inject(HttpClient);
  private readonly okGraphState = inject(OkGraphStateService);
  private readonly summaries = inject(ClusterSummaryService);
  private readonly projectContext = inject(ProjectContextService);

  private collectionUrl(projectId: number): string {
    return `${environment.BACKEND_URL}/api/projects/${projectId}/snapshots`;
  }

  /** List a project's snapshots (metadata only). */
  list(projectId: number): Observable<SnapshotMeta[]> {
    return this.http
      .get<ApiSnapshotMeta[]>(this.collectionUrl(projectId))
      .pipe(map(list => list.map(toMeta)), catchError(this.fail));
  }

  /**
   * Save the current base graph + completed cluster summaries under `projectId`.
   * Fails fast (no request) when there is no built graph; surfaces the cap and
   * name-clash 409s as typed {@link SnapshotError}s.
   */
  save(projectId: number, name: string): Observable<SnapshotMeta> {
    const graph = this.okGraphState.exportSnapshotGraph();
    if (!graph) {
      return throwError(
        () => new SnapshotError('no-graph', 'There is no graph to save yet.'),
      );
    }
    const summaries = this.summaries.exportSummaries();
    return this.http
      .post<ApiSnapshotMeta>(this.collectionUrl(projectId), { name, graph, summaries })
      .pipe(map(toMeta), catchError(this.fail));
  }

  /** Load a snapshot's full payload (the active project owns it). */
  load(snapshotId: number): Observable<SnapshotDetail> {
    return this.withProject(pid =>
      this.http
        .get<ApiSnapshotDetail>(`${this.collectionUrl(pid)}/${snapshotId}`)
        .pipe(map(toDetail), catchError(this.fail)),
    );
  }

  /** Rename a snapshot (v1 never overwrites the saved graph). */
  rename(snapshotId: number, name: string): Observable<SnapshotMeta> {
    return this.withProject(pid =>
      this.http
        .patch<ApiSnapshotMeta>(`${this.collectionUrl(pid)}/${snapshotId}`, { name })
        .pipe(map(toMeta), catchError(this.fail)),
    );
  }

  /**
   * Restore a loaded snapshot into the live OK-Graph state — instantly, with no
   * citation-graph rebuild and no cluster re-summarization (subtask 04). Order is
   * load-bearing: hydrate the summary store **first** (which pre-seeds the
   * re-summarization signature), then reconstruct the base graph; the summary
   * effect then fires, recomputes the identical signature, and no-ops.
   */
  applySnapshot(detail: SnapshotDetail): void {
    const g = detail.graph;
    this.summaries.hydrate(
      {
        nodes: g.nodes,
        edges: g.edges,
        resolution: g.resolution,
        maxLevels: g.maxLevels,
        seedId: g.seedId,
      },
      detail.summaries,
    );
    this.okGraphState.loadSnapshotGraph(g);
  }

  /** Convenience: load a snapshot and apply it in one step (UI entry point). */
  loadAndApply(snapshotId: number): Observable<SnapshotDetail> {
    return this.load(snapshotId).pipe(tap(detail => this.applySnapshot(detail)));
  }

  /** Delete a snapshot. */
  delete(snapshotId: number): Observable<void> {
    return this.withProject(pid =>
      this.http
        .delete<void>(`${this.collectionUrl(pid)}/${snapshotId}`)
        .pipe(catchError(this.fail)),
    );
  }

  /** Run `fn` with the active project id, or fail with a typed no-project error. */
  private withProject<T>(fn: (projectId: number) => Observable<T>): Observable<T> {
    const pid = this.projectContext.activeProjectId();
    if (pid === null) {
      return throwError(
        () => new SnapshotError('no-project', 'No active project is selected.'),
      );
    }
    return fn(pid);
  }

  /** Map an HTTP error to a typed SnapshotError (arrow so it keeps `this`-free). */
  private readonly fail = (err: unknown): Observable<never> => {
    if (err instanceof SnapshotError) return throwError(() => err);
    const http = err as HttpErrorResponse;
    const detail =
      typeof http?.error?.detail === 'string' ? http.error.detail : '';
    if (http?.status === 409) {
      if (/limit/i.test(detail)) {
        return throwError(
          () => new SnapshotError('limit', detail || 'Snapshot limit reached — delete one first.'),
        );
      }
      if (/name/i.test(detail)) {
        return throwError(
          () => new SnapshotError('duplicate-name', detail || 'A snapshot with that name already exists.'),
        );
      }
    }
    return throwError(
      () => new SnapshotError('other', detail || `Request failed (${http?.status ?? '?'}).`),
    );
  };
}
