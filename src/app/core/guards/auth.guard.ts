import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SupabaseService } from '../services/supabase.service';

/**
 * Gates the app shell behind an authenticated session (docs/supabase-saas-plan.md §5).
 *
 * Fail-open when the cloud backend is NOT configured: during the migration the
 * app still runs on the local Electron backend, so an empty supabaseUrl/anonKey
 * must never lock the user out. Once configured, an unauthenticated user is sent
 * to /login.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const supabase = inject(SupabaseService);
  const router = inject(Router);

  if (!supabase.isConfigured) {
    return true;
  }

  const session = await supabase.getSession();
  if (session) {
    return true;
  }

  return router.createUrlTree(['/login'], {
    queryParams: { redirect: state.url },
  });
};
