import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subscription } from 'rxjs';
import { OutlookService, AutoSavedEvent, AutoSaveErrorEvent } from '../../core/services/outlook.service';
import {
  DetectedInvoice,
  OutlookAccount,
  OutlookSettings,
  InvoiceReviewItem,
  InvoiceReviewStatus,
} from '../../core/models/outlook.models';

@Component({
  selector: 'app-outlook-inbox',
  templateUrl: './outlook-inbox.component.html',
  styleUrls: ['./outlook-inbox.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OutlookInboxComponent implements OnInit, OnDestroy {
  // ── State ────────────────────────────────────────────────────────────────────
  account: OutlookAccount | null = null;
  settings: OutlookSettings | null = null;
  items: InvoiceReviewItem[] = [];
  isPolling = false;
  isLoading = false;
  lastChecked: string | null = null;
  newSenderEmail = '';

  // Table columns
  readonly columns = ['confidence', 'sender', 'subject', 'attachment', 'size', 'receivedAt', 'actions'];

  private subs = new Subscription();

  constructor(
    private readonly outlook: OutlookService,
    private readonly snack: MatSnackBar,
    private readonly cd: ChangeDetectorRef,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    this.settings = await this.outlook.getSettings();
    this.account = await this.outlook.getAccount();
    this.isPolling = await this.outlook.isPolling();

    // Restore the review queue saved in the previous session
    const saved = await this.outlook.loadQueue();
    if (saved.length > 0) {
      this.items = saved;
    }

    // Subscribe to push events from the background poller
    this.subs.add(
      this.outlook.invoicesDetected$.subscribe(invoices => {
        this.mergeInvoices(invoices);
        this.persistQueue();
        this.snack.open(`${invoices.length} new invoice(s) detected`, 'View', { duration: 4000 });
        this.cd.markForCheck();
      }),
    );

    this.subs.add(
      this.outlook.pollComplete$.subscribe(event => {
        this.lastChecked = event.checkedAt;
        // Don't force isPolling = true here — the poller may have been stopped
        // while a poll was already in-flight. isPolling is owned by togglePolling().
        this.cd.markForCheck();
      }),
    );

    this.subs.add(
      this.outlook.pollError$.subscribe(msg => {
        this.snack.open(`Polling error: ${msg}`, 'Dismiss', { duration: 6000 });
        this.cd.markForCheck();
      }),
    );

    this.subs.add(
      this.outlook.autoSaved$.subscribe(({ invoice, filePath }: AutoSavedEvent) => {
        const existing = this.items.find(
          i => i.invoice.messageId === invoice.messageId && i.invoice.attachmentId === invoice.attachmentId,
        );
        if (existing) {
          existing.status = 'saved';
          existing.savedPath = filePath;
        } else {
          this.items.unshift({ invoice, status: 'saved', savedPath: filePath });
        }
        this.persistQueue();
        this.snack.open(`Auto-saved: ${invoice.attachmentName}`, undefined, { duration: 3000 });
        this.cd.markForCheck();
      }),
    );

    this.subs.add(
      this.outlook.autoSaveError$.subscribe(({ invoice, error }: AutoSaveErrorEvent) => {
        const existing = this.items.find(
          i => i.invoice.messageId === invoice.messageId && i.invoice.attachmentId === invoice.attachmentId,
        );
        if (existing) {
          existing.status = 'pending';
          existing.error = error;
        } else {
          // autoSaveError fires before invoicesDetected — pre-insert as pending
          // so mergeInvoices will skip it as a duplicate when invoicesDetected arrives.
          this.items.unshift({ invoice, status: 'pending', error });
        }
        this.persistQueue();
        this.snack.open(`Auto-save failed: ${error}`, 'Dismiss', { duration: 6000 });
        this.cd.markForCheck();
      }),
    );

    this.subs.add(
      this.outlook.warning$.subscribe(msg => {
        this.snack.open(`⚠ ${msg}`, 'Dismiss', { duration: 10000 });
      }),
    );

    // A3: keep isPolling in sync when the main process stops the poller
    // (e.g. on settings reset — no user action causes this, but it happens on
    // every settings save before B1 was fixed, and could still happen on errors).
    this.subs.add(
      this.outlook.pollerStopped$.subscribe(() => {
        this.isPolling = false;
        this.cd.markForCheck();
      }),
    );

    this.cd.markForCheck();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  // ── Auth actions ─────────────────────────────────────────────────────────────

  async login(): Promise<void> {
    this.isLoading = true;
    this.cd.markForCheck();

    try {
      const result = await this.outlook.login();

      if (result.success && result.account) {
        this.account = result.account;
        this.snack.open(`Logged in as ${result.account.username}`, undefined, { duration: 3000 });
      } else {
        this.snack.open(`Login failed: ${result.error}`, 'Dismiss', { duration: 5000 });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snack.open(`Login failed: ${msg}`, 'Dismiss', { duration: 5000 });
    } finally {
      this.isLoading = false;
      this.cd.markForCheck();
    }
  }

  async logout(): Promise<void> {
    await this.outlook.logout();
    this.account = null;
    this.items = [];
    this.isPolling = false;
    this.persistQueue(); // clear persisted queue on sign-out
    this.snack.open('Signed out', undefined, { duration: 2000 });
    this.cd.markForCheck();
  }

  // ── Email actions ────────────────────────────────────────────────────────────

  async fetchNow(): Promise<void> {
    this.isLoading = true;
    this.cd.markForCheck();

    try {
      const invoices = await this.outlook.fetchEmails();
      this.mergeInvoices(invoices);
      this.persistQueue();
      this.snack.open(`${invoices.length} invoice(s) found`, undefined, { duration: 3000 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snack.open(`Fetch failed: ${msg}`, 'Dismiss', { duration: 5000 });
    } finally {
      this.isLoading = false;
      this.cd.markForCheck();
    }
  }

  async togglePolling(): Promise<void> {
    const previous = this.isPolling;
    try {
      if (this.isPolling) {
        await this.outlook.stopPolling();
        this.isPolling = false;
      } else {
        await this.outlook.startPolling();
        this.isPolling = true;
      }
    } catch (err: unknown) {
      // Roll back to the previous state so the UI stays in sync with reality
      this.isPolling = previous;
      const msg = err instanceof Error ? err.message : String(err);
      this.snack.open(`Polling failed: ${msg}`, 'Dismiss', { duration: 5000 });
    }
    this.cd.markForCheck();
  }

  // ── Review actions ───────────────────────────────────────────────────────────

  async confirm(item: InvoiceReviewItem): Promise<void> {
    if (item.status === 'saving' || item.status === 'saved') return;
    if (!this.settings) return;

    item.status = 'saving';
    this.cd.markForCheck();

    const folder = item.targetFolder
      ?? `${this.settings.inboxFolder}/${item.invoice.suggestedSubFolder}`;

    const result = await this.outlook.saveAttachment({
      messageId: item.invoice.messageId,
      attachmentId: item.invoice.attachmentId,
      filename: item.invoice.attachmentName,
      targetFolder: folder,
    });

    if (result.success) {
      item.status = 'saved';
      item.savedPath = result.filePath;
    } else {
      item.status = 'pending'; // revert so the action buttons reappear for retry
      item.error = result.error;
      this.snack.open(`Save failed: ${result.error}`, 'Dismiss', { duration: 5000 });
    }

    this.persistQueue();
    this.cd.markForCheck();
  }

  reject(item: InvoiceReviewItem): void {
    item.status = 'rejected';
    this.persistQueue();
    this.cd.markForCheck();
  }

  async chooseFolder(item: InvoiceReviewItem): Promise<void> {
    const folder = await this.outlook.chooseFolder();
    if (folder) {
      item.targetFolder = folder;
      this.cd.markForCheck();
    }
  }

  // ── Trusted senders ──────────────────────────────────────────────────────────

  addTrustedSender(email: string): void {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    if (!this.settings) return;
    if (!this.settings.trustedSenders.includes(trimmed)) {
      this.settings.trustedSenders = [...this.settings.trustedSenders, trimmed];
      this.saveTrustedSendersNow();
    }
    this.newSenderEmail = '';
    this.cd.markForCheck();
  }

  removeTrustedSender(email: string): void {
    if (!this.settings) return;
    this.settings.trustedSenders = this.settings.trustedSenders.filter(s => s !== email);
    this.saveTrustedSendersNow();
    this.cd.markForCheck();
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  async saveSettings(): Promise<void> {
    if (!this.settings) return;
    this.settings = await this.outlook.saveSettings(this.settings);
    this.snack.open('Settings saved', undefined, { duration: 2000 });
    this.cd.markForCheck();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  confidenceLabel(level: string): string {
    return ({ high: 'High', medium: 'Medium', low: 'Low' } as any)[level] ?? level;
  }

  confidenceColor(level: string): string {
    return ({ high: 'accent', medium: 'warn', low: '' } as any)[level] ?? '';
  }

  trackByMessageId(_: number, item: InvoiceReviewItem): string {
    return `${item.invoice.messageId}-${item.invoice.attachmentId}`;
  }

  get pendingCount(): number {
    return this.items.filter(i => i.status === 'pending').length;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** Fire-and-forget queue write — non-fatal if it fails. */
  private persistQueue(): void {
    this.outlook.saveQueue(this.items).catch(() => {});
  }

  /**
   * Immediately persists trusted-sender changes so they survive navigation
   * without requiring an explicit "Save Settings" click.
   */
  private saveTrustedSendersNow(): void {
    if (!this.settings) return;
    // Send only trustedSenders — the local settings object already has the new value
    // and the view has been updated by the caller's markForCheck().
    // Do NOT overwrite this.settings with the server response: that response is built
    // from disk state and would silently discard any other unsaved local changes the
    // user may have made in the settings form (e.g. pollIntervalMinutes, imapHost).
    this.outlook.saveSettings({ trustedSenders: this.settings.trustedSenders })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        this.snack.open(`Failed to save trusted senders: ${msg}`, 'Dismiss', { duration: 4000 });
      });
  }

  private mergeInvoices(invoices: DetectedInvoice[]): void {
    for (const inv of invoices) {
      const exists = this.items.some(
        i => i.invoice.messageId === inv.messageId && i.invoice.attachmentId === inv.attachmentId,
      );
      if (!exists) {
        this.items.unshift({ invoice: inv, status: 'pending' });
      }
    }
  }
}
