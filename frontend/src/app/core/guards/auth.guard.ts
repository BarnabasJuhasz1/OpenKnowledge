import { inject } from '@angular/core';
import {
  CanActivateChildFn,
  CanActivateFn,
  Router,
} from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Blocks every feature route behind authentication. When the user is not signed
 * in, they're bounced to the public landing page with `?login=required`, which
 * the top-nav uses to pop the provider chooser open automatically.
 *
 * The session is resolved before bootstrap completes (see the app initializer),
 * so `isAuthenticated()` is authoritative by the time a guard runs.
 */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) {
    return true;
  }
  return router.createUrlTree(['/'], { queryParams: { login: 'required' } });
};

export const authGuardChild: CanActivateChildFn = (childRoute, state) =>
  authGuard(childRoute, state);
