import { Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';
import { Session } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';

export interface AuthResult {
  success: boolean;
  error?: string;
  /** True when signup succeeded but the user must confirm their email first. */
  needsEmailConfirmation?: boolean;
}

/**
 * Thin wrapper over Supabase email/password auth (docs/supabase-saas-plan.md §5).
 * Session state itself lives in {@link SupabaseService}; this service only drives
 * the sign-in/up/out transitions and normalizes errors for the UI.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(private supabase: SupabaseService) {}

  /** Emits the current session (null = signed out / cloud not configured). */
  get session$(): Observable<Session | null> {
    return this.supabase.session$;
  }

  get isAuthenticated$(): Observable<boolean> {
    return this.supabase.session$.pipe(map((s) => !!s));
  }

  get session(): Session | null {
    return this.supabase.session;
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    if (!this.supabase.isConfigured) {
      return { success: false, error: 'Cloud backend is not configured.' };
    }
    const { error } = await this.supabase.client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    return error ? { success: false, error: error.message } : { success: true };
  }

  async signUp(email: string, password: string): Promise<AuthResult> {
    if (!this.supabase.isConfigured) {
      return { success: false, error: 'Cloud backend is not configured.' };
    }
    const { data, error } = await this.supabase.client.auth.signUp({
      email: email.trim(),
      password,
    });
    if (error) {
      return { success: false, error: error.message };
    }
    // When email confirmation is on, signUp returns a user but no session.
    const needsEmailConfirmation = !data.session;
    return { success: true, needsEmailConfirmation };
  }

  async signOut(): Promise<void> {
    if (this.supabase.isConfigured) {
      await this.supabase.client.auth.signOut();
    }
  }
}
