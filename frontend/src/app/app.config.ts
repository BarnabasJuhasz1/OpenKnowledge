import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { routes } from './app.routes';
import { CachedRouteReuseStrategy } from './core/route-reuse.strategy';
import { projectInterceptor } from './core/interceptors/project.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([projectInterceptor])),
    provideAnimations(),
    { provide: RouteReuseStrategy, useClass: CachedRouteReuseStrategy },
  ]
};
