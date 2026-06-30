import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Tracks whether the cloud backend is currently reachable, so the app can show a
 * clear "can't reach the cloud" state instead of a silently-empty list
 * (docs/supabase-saas-plan.md §5 — online-only UX).
 *
 * The data services funnel every read through their `loadX()` methods, so those
 * are the single choke point: each calls {@link reportSuccess}/{@link reportError}
 * here. The browser `offline` event gives instant feedback before a request even
 * times out. Recovery is confirmed by the next successful read (the app's Retry
 * action), not assumed from the `online` event — being back on a network does not
 * prove the backend is reachable.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionStatusService {
  private readonly _offline = new BehaviorSubject<boolean>(false);
  /** Emits true while the cloud backend appears unreachable. */
  readonly offline$: Observable<boolean> = this._offline.asObservable();

  constructor(@Inject(PLATFORM_ID) platformId: Object) {
    if (isPlatformBrowser(platformId)) {
      window.addEventListener('offline', () => this.setOffline(true));
    }
  }

  get offline(): boolean {
    return this._offline.value;
  }

  /** A gateway read succeeded — we're online. */
  reportSuccess(): void {
    this.setOffline(false);
  }

  /** A gateway read threw — flag offline only for connectivity-style failures. */
  reportError(err: unknown): void {
    if (this.isConnectivityError(err)) {
      this.setOffline(true);
    }
  }

  private setOffline(value: boolean): void {
    if (this._offline.value !== value) {
      this._offline.next(value);
    }
  }

  /**
   * supabase-js surfaces a lost connection as a fetch `TypeError` ("Failed to
   * fetch") or a message mentioning the network. Auth / RLS / validation errors
   * are NOT connectivity problems and must not raise the offline banner (those
   * are surfaced per-action by the originating component).
   */
  private isConnectivityError(err: unknown): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
    // OS-level error codes are matched as whole tokens (\b) so substrings inside
    // ordinary words don't trigger a false positive — e.g. "econn" must not match
    // "reconnect", nor "etimedout" inside a longer word.
    return /failed to fetch|network ?error|fetch failed|load failed|timeout|getaddrinfo|\b(econnrefused|econnreset|econnaborted|enotfound|etimedout|eai_again|enetunreach|ehostunreach)\b/.test(
      msg,
    );
  }
}
