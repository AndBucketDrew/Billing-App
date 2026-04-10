import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subscription } from 'rxjs';
import { OutlookService } from '../../core/services/outlook.service';
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

    // Subscribe to push events from the background poller
    this.subs.add(
      this.outlook.invoicesDetected$.subscribe(invoices => {
        this.mergeInvoices(invoices);
        this.snack.open(`${invoices.length} new invoice(s) detected`, 'View', { duration: 4000 });
        this.cd.markForCheck();
      }),
    );

    this.subs.add(
      this.outlook.pollComplete$.subscribe(event => {
        this.lastChecked = event.checkedAt;
        this.isPolling = true;
        this.cd.markForCheck();
      }),
    );

    this.subs.add(
      this.outlook.pollError$.subscribe(msg => {
        this.snack.open(`Polling error: ${msg}`, 'Dismiss', { duration: 6000 });
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

    const result = await this.outlook.login();

    if (result.success && result.account) {
      this.account = result.account;
      this.snack.open(`Logged in as ${result.account.username}`, undefined, { duration: 3000 });
    } else {
      this.snack.open(`Login failed: ${result.error}`, 'Dismiss', { duration: 5000 });
    }

    this.isLoading = false;
    this.cd.markForCheck();
  }

  async logout(): Promise<void> {
    await this.outlook.logout();
    this.account = null;
    this.items = [];
    this.isPolling = false;
    this.snack.open('Signed out', undefined, { duration: 2000 });
    this.cd.markForCheck();
  }

  // ── Email actions ────────────────────────────────────────────────────────────

  async fetchNow(): Promise<void> {
    this.isLoading = true;
    this.cd.markForCheck();

    const invoices = await this.outlook.fetchEmails();
    this.mergeInvoices(invoices);

    this.isLoading = false;
    this.snack.open(`${invoices.length} invoice(s) found`, undefined, { duration: 3000 });
    this.cd.markForCheck();
  }

  async togglePolling(): Promise<void> {
    if (this.isPolling) {
      await this.outlook.stopPolling();
      this.isPolling = false;
    } else {
      await this.outlook.startPolling();
      this.isPolling = true;
    }
    this.cd.markForCheck();
  }

  // ── Review actions ───────────────────────────────────────────────────────────

  async confirm(item: InvoiceReviewItem): Promise<void> {
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
      item.status = 'confirmed'; // revert to let user retry
      item.error = result.error;
      this.snack.open(`Save failed: ${result.error}`, 'Dismiss', { duration: 5000 });
    }

    this.cd.markForCheck();
  }

  reject(item: InvoiceReviewItem): void {
    item.status = 'rejected';
    this.cd.markForCheck();
  }

  async chooseFolder(item: InvoiceReviewItem): Promise<void> {
    const folder = await this.outlook.chooseFolder();
    if (folder) {
      item.targetFolder = folder;
      this.cd.markForCheck();
    }
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
