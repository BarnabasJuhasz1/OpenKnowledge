import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { routes } from './app.routes';
import { CachedRouteReuseStrategy } from './core/route-reuse.strategy';
import { projectInterceptor } from './core/interceptors/project.interceptor';
import { AuthService } from './core/services/auth.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([projectInterceptor])),
    provideAnimations(),
    // Resolve the auth session before the first navigation so route guards can
    // make an authoritative allow/deny decision on a hard page load.
    provideAppInitializer(() => inject(AuthService).loadSession()),
    { provide: RouteReuseStrategy, useClass: CachedRouteReuseStrategy },
  ]
};
