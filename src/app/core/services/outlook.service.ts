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

import { Injectable, Inject, PLATFORM_ID, NgZone } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Subject, Observable } from 'rxjs';
import type { ElectronAPI } from '../../../../electron/preload';
import {
  DetectedInvoice,
  InvoiceReviewItem,
  OutlookAccount,
  OutlookSettings,
} from '../models/outlook.models';

export interface AutoSavedEvent {
  invoice: DetectedInvoice;
  filePath: string;
  /** PDF text layer extracted at save time (absent for non-PDF / image-only PDFs). */
  extractedText?: string;
}

export interface AutoSaveErrorEvent {
  invoice: DetectedInvoice;
  error: string;
}

export interface PollCompleteEvent {
  checkedAt: string;
  found: number;
}

@Injectable({ providedIn: 'root' })
export class OutlookService {
  // NOTE: This service is intentionally long-lived (providedIn: 'root').
  // Angular never calls ngOnDestroy on root-scoped services; IPC listeners
  // registered in the constructor are valid for the entire process lifetime,
  // which in Electron equals the app lifetime. No explicit cleanup is needed.

  // ── Push-event subjects ──────────────────────────────────────────────────────
  private readonly _invoicesDetected$ = new Subject<DetectedInvoice[]>();
  private readonly _pollComplete$ = new Subject<PollCompleteEvent>();
  private readonly _pollError$ = new Subject<string>();
  private readonly _autoSaved$ = new Subject<AutoSavedEvent>();
  private readonly _autoSaveError$ = new Subject<AutoSaveErrorEvent>();
  private readonly _warning$ = new Subject<string>();
  /** A3: emitted when the main process stops the poller (e.g. on settings reset) */
  private readonly _pollerStopped$ = new Subject<void>();

  /** Emitted whenever the background poller finds new invoices */
  readonly invoicesDetected$: Observable<DetectedInvoice[]> = this._invoicesDetected$.asObservable();
  /** Emitted after every successful poll cycle */
  readonly pollComplete$: Observable<PollCompleteEvent> = this._pollComplete$.asObservable();
  /** Emitted when the poller encounters a network or auth error */
  readonly pollError$: Observable<string> = this._pollError$.asObservable();
  /** Emitted when a high-confidence invoice is auto-saved during polling */
  readonly autoSaved$: Observable<AutoSavedEvent> = this._autoSaved$.asObservable();
  /** Emitted when auto-saving a high-confidence invoice fails */
  readonly autoSaveError$: Observable<AutoSaveErrorEvent> = this._autoSaveError$.asObservable();
  /** Emitted for non-fatal advisories (e.g. insecure credential storage fallback) */
  readonly warning$: Observable<string> = this._warning$.asObservable();
  /** A3: emitted when the main process stops the poller — use to sync isPolling in the UI */
  readonly pollerStopped$: Observable<void> = this._pollerStopped$.asObservable();

  // ── Bound handlers stored for removal ───────────────────────────────────────
  private readonly onInvoicesDetected = (invoices: DetectedInvoice[]) =>
    this.zone.run(() => this._invoicesDetected$.next(invoices));

  private readonly onPollComplete = (event: PollCompleteEvent) =>
    this.zone.run(() => this._pollComplete$.next(event));

  private readonly onPollError = (msg: string) =>
    this.zone.run(() => this._pollError$.next(msg));

  private readonly onAutoSaved = (event: AutoSavedEvent) =>
    this.zone.run(() => this._autoSaved$.next(event));

  private readonly onAutoSaveError = (event: AutoSaveErrorEvent) =>
    this.zone.run(() => this._autoSaveError$.next(event));

  private readonly onWarning = (msg: string) =>
    this.zone.run(() => this._warning$.next(msg));

  // A3: no payload — main process calls MailPoller.stop() which emits this event
  private readonly onPollerStopped = () =>
    this.zone.run(() => this._pollerStopped$.next());

  constructor(
    @Inject(PLATFORM_ID) private platformId: object,
    private readonly zone: NgZone,
  ) {
    if (this.isElectron()) {
      const api = this.api;
      api.on('outlook:invoicesDetected', this.onInvoicesDetected);
      api.on('outlook:pollComplete', this.onPollComplete);
      api.on('outlook:pollError', this.onPollError);
      api.on('outlook:autoSaved', this.onAutoSaved);
      api.on('outlook:autoSaveError', this.onAutoSaveError);
      api.on('outlook:warning', this.onWarning);
      api.on('outlook:pollerStopped', this.onPollerStopped); // A3
    }
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
    if (!this.isElectron()) return Promise.resolve(null);
    return this.api.getAccount().then(r => (r.success ? r.account : null));
  }

  // ── Email detection ──────────────────────────────────────────────────────────

  /** Triggers an immediate poll cycle. Results arrive via invoicesDetected$. */
  fetchEmails(): Promise<void> {
    if (!this.isElectron()) {
      this._invoicesDetected$.next(MOCK_INVOICES);
      return Promise.resolve();
    }
    return this.api.fetchEmails().then(() => undefined);
  }

  // ── File operations ──────────────────────────────────────────────────────────

  saveAttachment(args: {
    messageId: string;
    attachmentId: string;
    filename: string;
    subject?: string;
    targetFolder: string;
  }): Promise<{ success: boolean; filePath?: string; extractedText?: string; error?: string }> {
    if (!this.isElectron()) return Promise.resolve({ success: false, error: 'Not in Electron' });
    return this.api.saveAttachment(args) as any;
  }

  /** Reads a saved invoice file's bytes (base64) for the in-app preview. */
  readSavedFile(filePath: string): Promise<{ success: boolean; base64?: string; error?: string }> {
    if (!this.isElectron()) return Promise.resolve({ success: false, error: 'Not in Electron' });
    return (this.api as any).readSavedFile(filePath);
  }

  /** Opens a saved invoice file in the OS default viewer (used for .docx). */
  openFile(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) return Promise.resolve({ success: false, error: 'Not in Electron' });
    return (this.api as any).openFile(filePath);
  }

  chooseFolder(): Promise<string | null> {
    if (!this.isElectron()) return Promise.resolve(null);
    return this.api.chooseFolder().then(r => (r.success ? r.folderPath : null));
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
    if (!this.isElectron()) return Promise.resolve(false);
    return this.api.isPolling().then(r => r.polling);
  }

  /** Resets the scan window to `lookbackDays` ago and triggers an immediate re-poll. */
  resetScan(lookbackDays = 7): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron()) return Promise.resolve({ success: true });
    return this.api.resetScan(lookbackDays) as any;
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

  // ── Review-queue persistence ──────────────────────────────────────────────────

  /** Loads the review queue that was persisted during the previous session. */
  loadQueue(): Promise<InvoiceReviewItem[]> {
    if (!this.isElectron()) return Promise.resolve([]);
    return this.api.loadQueue();
  }

  /** Persists the current review queue to disk so it survives restarts. */
  saveQueue(items: InvoiceReviewItem[]): Promise<void> {
    if (!this.isElectron()) return Promise.resolve();
    return this.api.saveQueue(items);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  isElectron(): boolean {
    return isPlatformBrowser(this.platformId) && !!(window as any as { electronAPI?: ElectronAPI }).electronAPI?.outlook;
  }

  private get api(): ElectronAPI['outlook'] {
    return (window as Window & { electronAPI: ElectronAPI }).electronAPI.outlook;
  }
}

// ─── Defaults & mocks ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: OutlookSettings = {
  connectionType: 'msal',
  clientId: '',
  imapHost: '',
  imapPort: 993,
  imapTls: true,
  imapIgnoreCertErrors: false,
  imapUser: '',
  imapPassword: '',
  hasStoredPassword: false,
  inboxFolder: '',
  pollIntervalMinutes: 5,
  trustedSenders: [],
  autoDownloadHighConfidence: false,
};

const MOCK_INVOICES: DetectedInvoice[] = [
  {
    messageId: 'mock-1',
    attachmentId: 'att-1',
    senderName: 'Amazon',
    senderEmail: 'auto-confirm@amazon.com',
    subject: 'Your Amazon order #123 – Invoice enclosed',
    receivedAt: new Date().toISOString(),
    attachmentName: 'invoice_2024_001.pdf',
    attachmentSize: 48320,
    confidence: 'high',
    confidenceScore: 85,
    reasons: ['Filename contains "invoice"', 'Subject contains "invoice"', 'PDF attachment', 'Known commercial sender (amazon)'],
    suggestedSubFolder: '2024/04-April',
    connectionType: 'mock',
  },
  {
    messageId: 'mock-2',
    attachmentId: 'att-2',
    senderName: 'Office Supplies GmbH',
    senderEmail: 'billing@officesupplies.at',
    subject: 'Rechnung März 2024',
    receivedAt: new Date(Date.now() - 3600_000).toISOString(),
    attachmentName: 'rechnung_0042.pdf',
    attachmentSize: 22100,
    confidence: 'medium',
    confidenceScore: 55,
    reasons: ['Filename contains "rechnung"', 'Subject contains "rechnung"', 'PDF attachment'],
    suggestedSubFolder: '2024/03-March',
    connectionType: 'mock',
  },
];
