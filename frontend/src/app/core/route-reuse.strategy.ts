import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  RouteReuseStrategy,
} from '@angular/router';

/**
 * Keeps selected routes alive across navigation by detaching and caching their
 * rendered view instead of letting Angular destroy and rebuild the component.
 *
 * Used for the citation-graph tab: leaving and returning to it preserves the
 * live component instance — loaded graph, pan/zoom, node positions and the
 * current selection all stay exactly as the user left them. All other routes
 * keep Angular's default behaviour.
 */
@Injectable()
export class CachedRouteReuseStrategy implements RouteReuseStrategy {
  /** Route `path`s whose component instances should survive navigation. */
  private static readonly CACHED_PATHS = new Set<string>(['clustering']);

  private readonly handlers = new Map<string, DetachedRouteHandle>();

  private static pathOf(route: ActivatedRouteSnapshot): string | null {
    return route.routeConfig?.path ?? null;
  }

  private static isCached(route: ActivatedRouteSnapshot): boolean {
    const path = CachedRouteReuseStrategy.pathOf(route);
    return path !== null && CachedRouteReuseStrategy.CACHED_PATHS.has(path);
  }

  /** Detach (and later cache) only the routes we want to keep alive. */
  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return CachedRouteReuseStrategy.isCached(route);
  }

  /** Store the detached view keyed by its route path. */
  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const path = CachedRouteReuseStrategy.pathOf(route);
    if (path === null || !CachedRouteReuseStrategy.CACHED_PATHS.has(path)) {
      return;
    }
    if (handle) {
      this.handlers.set(path, handle);
    } else {
      this.handlers.delete(path);
    }
  }

  /** Re-attach a cached view when returning to its route. */
  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const path = CachedRouteReuseStrategy.pathOf(route);
    return path !== null && this.handlers.has(path);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const path = CachedRouteReuseStrategy.pathOf(route);
    if (path === null) {
      return null;
    }
    return this.handlers.get(path) ?? null;
  }

  /** Default reuse semantics for everything else. */
  shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    curr: ActivatedRouteSnapshot,
  ): boolean {
    if (future.routeConfig !== curr.routeConfig) {
      return false;
    }
    // Switching to a different project must rebuild the dashboard subtree so
    // each feature view reloads its project-scoped data instead of showing the
    // previous project's library/bookshelf.
    const futureProject = future.params['projectId'];
    const currProject = curr.params['projectId'];
    if (futureProject !== undefined || currProject !== undefined) {
      if (futureProject !== currProject) {
        // Drop cached views (e.g. citgraph) so they don't carry into another
        // project.
        this.handlers.clear();
        return false;
      }
      return true;
    }
    return true;
  }
}
