import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject, Observable } from 'rxjs';
import { createClient, SupabaseClient, Session } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';

/**
 * Owns the Supabase client and the current auth session.
 *
 * Scaffold for the SaaS migration (docs/supabase-saas-plan.md §5). Nothing in
 * the app depends on this yet — the SupabaseDataGateway (next slice) and the
 * auth UI will build on top of it. Safe to ship un-configured: with empty
 * credentials the client is simply absent and `isConfigured` is false.
 */
@Injectable({ providedIn: 'root' })
export class SupabaseService {
  private readonly _client: SupabaseClient | null;

  private readonly _session = new BehaviorSubject<Session | null>(null);
  /** Emits the current auth session (null = signed out / not configured). */
  readonly session$: Observable<Session | null> = this._session.asObservable();

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    const { supabaseUrl, supabaseAnonKey } = environment;

    // Auth/session persistence needs localStorage — skip entirely on the server
    // (the repo carries an SSR/prerender config that must not touch the client).
    if (!isPlatformBrowser(this.platformId)) {
      this._client = null;
      return;
    }

    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn(
        '[supabase] No supabaseUrl/supabaseAnonKey configured — cloud backend disabled. ' +
        'Set them in src/environments/environment*.ts once the Supabase project (Phase 0) exists.'
      );
      this._client = null;
      return;
    }

    this._client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Electron renderer is locked down with no redirect URL handling — we
        // never parse an OAuth callback out of the address bar.
        detectSessionInUrl: false,
      },
    });

    this._client.auth.getSession().then(({ data }) => this._session.next(data.session));
    this._client.auth.onAuthStateChange((_event, session) => this._session.next(session));
  }

  /** True once real credentials are present (Phase 0 done). */
  get isConfigured(): boolean {
    return this._client !== null;
  }

  /** The Supabase client. Throws if used before credentials are configured. */
  get client(): SupabaseClient {
    if (!this._client) {
      throw new Error('SupabaseService used before supabaseUrl/supabaseAnonKey were configured.');
    }
    return this._client;
  }

  get session(): Session | null {
    return this._session.value;
  }

  /**
   * Resolves the persisted session from storage. Use this (not the synchronous
   * `session` getter) in route guards at app start, before onAuthStateChange
   * has fired. Returns null when the cloud backend is not configured.
   */
  async getSession(): Promise<Session | null> {
    if (!this._client) return null;
    const { data } = await this._client.auth.getSession();
    return data.session;
  }
}
