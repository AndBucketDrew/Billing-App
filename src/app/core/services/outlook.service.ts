/**
 * OutlookService — Angular wrapper around the Outlook IPC bridge.
 *
 * All IPC calls are guarded: if the app is not running inside Electron
 * (e.g. ng serve in the browser), mock responses are returned so the
 * component can be developed and previewed without a live Electron shell.
 *
 * Push events from the main process (polling results, errors) are exposed
 * as RxJS Observables so components can subscribe reactively.
 */

import { Injectable, Inject, PLATFORM_ID, OnDestroy, NgZone } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Subject, Observable } from 'rxjs';
import {
  DetectedInvoice,
  OutlookAccount,
  OutlookSettings,
} from '../models/outlook.models';
import { DEMO_OUTLOOK_ACCOUNT, DEMO_OUTLOOK_EMAILS } from './demo-data';

export interface PollCompleteEvent {
  checkedAt: string;
  found: number;
}

@Injectable({ providedIn: 'root' })
export class OutlookService implements OnDestroy {
  // ── Push-event subjects ──────────────────────────────────────────────────────
  private readonly _invoicesDetected$ = new Subject<DetectedInvoice[]>();
  private readonly _pollComplete$ = new Subject<PollCompleteEvent>();
  private readonly _pollError$ = new Subject<string>();

  /** Emitted whenever the background poller finds new invoices */
  readonly invoicesDetected$: Observable<DetectedInvoice[]> = this._invoicesDetected$.asObservable();
  /** Emitted after every successful poll cycle */
  readonly pollComplete$: Observable<PollCompleteEvent> = this._pollComplete$.asObservable();
  /** Emitted when the poller encounters a network or auth error */
  readonly pollError$: Observable<string> = this._pollError$.asObservable();

  // ── Bound handlers stored for removal ───────────────────────────────────────
  private readonly onInvoicesDetected = (invoices: DetectedInvoice[]) =>
    this.zone.run(() => this._invoicesDetected$.next(invoices));

  private readonly onPollComplete = (event: PollCompleteEvent) =>
    this.zone.run(() => this._pollComplete$.next(event));

  private readonly onPollError = (msg: string) =>
    this.zone.run(() => this._pollError$.next(msg));

  constructor(
    @Inject(PLATFORM_ID) private platformId: object,
    private readonly zone: NgZone,
  ) {
    if (this.isElectron()) {
      const api = this.api;
      api.on('outlook:invoicesDetected', this.onInvoicesDetected);
      api.on('outlook:pollComplete', this.onPollComplete);
      api.on('outlook:pollError', this.onPollError);
    }
  }

  ngOnDestroy(): void {
    if (this.isElectron()) {
      const api = this.api;
      api.off('outlook:invoicesDetected', this.onInvoicesDetected);
      api.off('outlook:pollComplete', this.onPollComplete);
      api.off('outlook:pollError', this.onPollError);
    }
    this._invoicesDetected$.complete();
    this._pollComplete$.complete();
    this._pollError$.complete();
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────

  login(): Promise<{ success: boolean; account?: OutlookAccount; error?: string }> {
    if (!this.isElectron()) return Promise.resolve({ success: false, error: 'Not in Electron' });
    return this.api.login() as any;
  }

  logout(): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) return Promise.resolve({ success: true });
    return this.api.logout() as any;
  }

  getAccount(): Promise<OutlookAccount | null> {
    if (!this.isElectron()) return Promise.resolve(DEMO_OUTLOOK_ACCOUNT);
    return this.api.getAccount().then((r: any) => (r.success ? r.account : null));
  }

  // ── Email detection ──────────────────────────────────────────────────────────

  fetchEmails(): Promise<DetectedInvoice[]> {
    if (!this.isElectron()) return Promise.resolve(DEMO_OUTLOOK_EMAILS);
    return this.api.fetchEmails().then((r: any) => (r.success ? r.invoices : []));
  }

  // ── File operations ──────────────────────────────────────────────────────────

  saveAttachment(args: {
    messageId: string;
    attachmentId: string;
    filename: string;
    targetFolder: string;
  }): Promise<{ success: boolean; filePath?: string; error?: string }> {
    if (!this.isElectron()) {
      return Promise.resolve({
        success: true,
        filePath: `${args.targetFolder}/${args.filename}`,
      });
    }
    return this.api.saveAttachment(args) as any;
  }

  chooseFolder(): Promise<string | null> {
    if (!this.isElectron()) return Promise.resolve('C:/GoodViennaTours/Invoices/2026/04-April');
    return this.api.chooseFolder().then((r: any) => (r.success ? r.folderPath : null));
  }

  // ── Polling ──────────────────────────────────────────────────────────────────

  startPolling(): Promise<void> {
    if (!this.isElectron()) return Promise.resolve();
    return this.api.startPolling().then(() => undefined);
  }

  stopPolling(): Promise<void> {
    if (!this.isElectron()) return Promise.resolve();
    return this.api.stopPolling().then(() => undefined);
  }

  isPolling(): Promise<boolean> {
    if (!this.isElectron()) return Promise.resolve(true);
    return this.api.isPolling().then((r: any) => r.polling);
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  getSettings(): Promise<OutlookSettings> {
    if (!this.isElectron()) return Promise.resolve(DEFAULT_SETTINGS);
    return this.api.getSettings();
  }

  saveSettings(updates: Partial<OutlookSettings>): Promise<OutlookSettings> {
    if (!this.isElectron()) return Promise.resolve({ ...DEFAULT_SETTINGS, ...updates });
    return this.api.saveSettings(updates);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  isElectron(): boolean {
    return isPlatformBrowser(this.platformId) && !!((window as any).electronAPI?.outlook);
  }

  private get api() {
    return (window as any).electronAPI.outlook;
  }
}

// ─── Defaults & mocks ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: OutlookSettings = {
  clientId: '',
  inboxFolder: '',
  pollIntervalMinutes: 5,
};

