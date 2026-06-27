/**
 * OutlookInboxStore — stateful facade shared by the Outlook shell and its two
 * child pages (Invoice Detection + PDF Parser).
 *
 * Provided at the OutlookShellComponent level (NOT root) so it is created when the
 * user enters /outlook and destroyed when they leave — giving correct teardown of
 * the background-poller subscriptions. The shell and both child pages resolve the
 * same instance through the element-injector hierarchy, so all three views read a
 * single source of truth.
 *
 * State is exposed as signals; OnPush templates that read them re-render
 * automatically, which is why this class carries no ChangeDetectorRef.
 */

import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subscription, merge } from 'rxjs';
import { take } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import {
  ExportConfirmDialogComponent,
  ExportConfirmData,
  ExportConfirmResult,
} from './export-confirm-dialog.component';
import { EditConfirmDialogComponent, EditConfirmResult } from './edit-confirm-dialog.component';
import { OutlookService, AutoSavedEvent, AutoSaveErrorEvent } from '../../core/services/outlook.service';
import { SettingsService } from '../../core/services/settings.service';
import { ExcelExportService } from '../../core/services/excel-export.service';
import { SepaExportService, SepaExportResult } from '../../core/services/sepa-export.service';
import {
  DetectedInvoice,
  OutlookAccount,
  OutlookSettings,
  InvoiceReviewItem,
  ParsedInvoiceFields,
} from '../../core/models/outlook.models';
import { parseInvoiceFields } from '../../../../electron/invoice-parser/invoice-field-parser';

@Injectable()
export class OutlookInboxStore implements OnDestroy {
  // ── State ────────────────────────────────────────────────────────────────────
  readonly account = signal<OutlookAccount | null>(null);
  readonly settings = signal<OutlookSettings | null>(null);
  readonly items = signal<InvoiceReviewItem[]>([]);
  readonly isPolling = signal(false);
  readonly isLoading = signal(false);
  readonly lastChecked = signal<string | null>(null);

  // ── Preview state ────────────────────────────────────────────────────────────
  /** trackBy key of the invoice currently shown in the preview pane. */
  readonly selectedKey = signal<string | null>(null);
  readonly previewUrl = signal<SafeResourceUrl | null>(null);
  readonly previewMessage = signal<string | null>(null);
  readonly previewLoading = signal(false);
  private previewBlobUrl: string | null = null;
  /**
   * trackBy keys of items whose source document the user has actually opened in the
   * preview pane this session. A parsed invoice can only be confirmed after it has been
   * previewed, so the user can't blindly export an unverified extraction.
   */
  private readonly previewedKeys = signal(new Set<string>());

  /**
   * trackBy keys of already-confirmed invoices the user is currently editing on the
   * Confirmed tab. A dirty row stays confirmed and on the Confirmed page, but shows a
   * "Confirm changes" action instead of plain "Done"; confirming clears `exported` so the
   * row is re-included in the next export. Transient (not persisted).
   */
  private readonly dirtyKeys = signal(new Set<string>());

  /** localStorage flag: user opted out of the "will be exported again" notice. */
  private static readonly REEXPORT_NOTICE_KEY = 'outlook.hideReexportNotice';

  // ── Derived state ──────────────────────────────────────────────────────────────
  readonly pendingCount = computed(() => this.items().filter(i => i.status === 'pending').length);

  /** Items that have been saved AND carry parsed payee/amount data (PDFs with a text layer). */
  readonly parsedItems = computed(() => this.items().filter(i => i.status === 'saved' && !!i.parsedFields));

  /** Parsed items still in play — excludes the ones the user has set aside via "Ignore". */
  readonly activeParsedItems = computed(() => this.parsedItems().filter(i => !i.ignored));

  /** Parsed items the user has set aside; shown on the Ignored tab and restorable. */
  readonly ignoredItems = computed(() => this.parsedItems().filter(i => i.ignored));

  /** Parsed items the user has reviewed and confirmed. */
  readonly confirmedItems = computed(() => this.activeParsedItems().filter(i => i.reviewConfirmed));

  /** Confirmed items not yet written to an Excel file — the ones a new export includes. */
  readonly exportableItems = computed(() => this.confirmedItems().filter(i => !i.exported));

  readonly selectedItem = computed(() =>
    this.parsedItems().find(i => this.trackByMessageId(0, i) === this.selectedKey()),
  );

  private subs = new Subscription();
  private initialized = false;

  constructor(
    private readonly outlook: OutlookService,
    private readonly snack: MatSnackBar,
    private readonly settingsService: SettingsService,
    private readonly excel: ExcelExportService,
    private readonly sepa: SepaExportService,
    private readonly sanitizer: DomSanitizer,
    private readonly dialog: MatDialog,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.settings.set(await this.outlook.getSettings());
    this.account.set(await this.outlook.getAccount());
    this.isPolling.set(await this.outlook.isPolling());

    // Restore the review queue saved in the previous session
    const saved = await this.outlook.loadQueue();
    if (saved.length > 0) {
      this.items.set(saved);
    }

    // Subscribe to push events from the background poller
    this.subs.add(
      this.outlook.invoicesDetected$.subscribe(invoices => {
        this.mergeInvoices(invoices);
        this.persistQueue();
        this.snack.open(`${invoices.length} new invoice(s) detected`, 'View', { duration: 4000 });
      }),
    );

    this.subs.add(
      this.outlook.pollComplete$.subscribe(event => {
        this.lastChecked.set(event.checkedAt);
        // Don't force isPolling = true here — the poller may have been stopped
        // while a poll was already in-flight. isPolling is owned by togglePolling().
      }),
    );

    this.subs.add(
      this.outlook.pollError$.subscribe(msg => {
        this.snack.open(`Polling error: ${msg}`, 'Dismiss', { duration: 6000 });
      }),
    );

    this.subs.add(
      this.outlook.autoSaved$.subscribe(({ invoice, filePath, extractedText }: AutoSavedEvent) => {
        const parsedFields = this.parseFields(extractedText, invoice.senderName);
        const items = this.items();
        const existing = items.find(
          i => i.invoice.messageId === invoice.messageId && i.invoice.attachmentId === invoice.attachmentId,
        );
        if (existing) {
          existing.status = 'saved';
          existing.savedPath = filePath;
          existing.parsedFields = parsedFields;
          this.items.set([...items]); // new reference so the table re-renders the updated row
        } else {
          this.items.set([{ invoice, status: 'saved', savedPath: filePath, parsedFields }, ...items]);
        }
        this.persistQueue();
        this.snack.open(`Auto-saved: ${invoice.attachmentName}`, undefined, { duration: 3000 });
      }),
    );

    this.subs.add(
      this.outlook.autoSaveError$.subscribe(({ invoice, error }: AutoSaveErrorEvent) => {
        const items = this.items();
        const existing = items.find(
          i => i.invoice.messageId === invoice.messageId && i.invoice.attachmentId === invoice.attachmentId,
        );
        if (existing) {
          existing.status = 'pending';
          existing.error = error;
          this.items.set([...items]);
        } else {
          // autoSaveError fires before invoicesDetected — pre-insert as pending
          // so mergeInvoices will skip it as a duplicate when invoicesDetected arrives.
          this.items.set([{ invoice, status: 'pending', error }, ...items]);
        }
        this.persistQueue();
        this.snack.open(`Auto-save failed: ${error}`, 'Dismiss', { duration: 6000 });
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
        this.isPolling.set(false);
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.clearPreview(); // release any open Blob URL
  }

  // ── Auth actions ─────────────────────────────────────────────────────────────

  async login(): Promise<void> {
    this.isLoading.set(true);

    try {
      const result = await this.outlook.login();

      if (result.success && result.account) {
        this.account.set(result.account);
        this.snack.open(`Logged in as ${result.account.username}`, undefined, { duration: 3000 });
      } else {
        this.snack.open(`Login failed: ${result.error}`, 'Dismiss', { duration: 5000 });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snack.open(`Login failed: ${msg}`, 'Dismiss', { duration: 5000 });
    } finally {
      this.isLoading.set(false);
    }
  }

  async logout(): Promise<void> {
    await this.outlook.logout();
    this.account.set(null);
    this.items.set([]);
    this.isPolling.set(false);
    this.persistQueue(); // clear persisted queue on sign-out
    this.snack.open('Signed out', undefined, { duration: 2000 });
  }

  // ── Email actions ────────────────────────────────────────────────────────────

  async fetchNow(): Promise<void> {
    this.isLoading.set(true);

    try {
      await this.outlook.fetchEmails(); // triggers an immediate poll, returns right away
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snack.open(`Fetch failed: ${msg}`, 'Dismiss', { duration: 5000 });
      this.isLoading.set(false);
      return;
    }

    // Stop the spinner when the poll finishes (complete or error).
    // A 120-second safety-net timeout guards against a poll that never responds.
    const timeout = setTimeout(() => this.isLoading.set(false), 120_000);

    merge(this.outlook.pollComplete$, this.outlook.pollError$)
      .pipe(take(1))
      .subscribe(() => {
        clearTimeout(timeout);
        this.isLoading.set(false);
      });
  }

  async resetScan(): Promise<void> {
    if (!confirm('Clear all pending items and rescan the last 30 days? This cannot be undone.')) return;

    this.isLoading.set(true);

    // Drop pending and rejected items so the rescan can re-detect them.
    // Saved items are kept so the user retains a record of what was already filed.
    this.items.set(this.items().filter(i => i.status === 'saved' || i.status === 'saving'));
    this.persistQueue();

    try {
      const result = await this.outlook.resetScan(30);
      if (!result.success) {
        this.snack.open(`Rescan failed: ${result.error}`, 'Dismiss', { duration: 5000 });
        this.isLoading.set(false);
        return;
      }
      this.snack.open('Rescanning last 30 days…', undefined, { duration: 3000 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snack.open(`Rescan failed: ${msg}`, 'Dismiss', { duration: 5000 });
      this.isLoading.set(false);
      return;
    }

    // Keep the spinner up until the rescan poll finishes, same as fetchNow().
    const timeout = setTimeout(() => this.isLoading.set(false), 120_000);

    merge(this.outlook.pollComplete$, this.outlook.pollError$)
      .pipe(take(1))
      .subscribe(() => {
        clearTimeout(timeout);
        this.isLoading.set(false);
      });
  }

  async togglePolling(): Promise<void> {
    const previous = this.isPolling();
    try {
      if (previous) {
        await this.outlook.stopPolling();
        this.isPolling.set(false);
      } else {
        await this.outlook.startPolling();
        this.isPolling.set(true);
      }
    } catch (err: unknown) {
      // Roll back to the previous state so the UI stays in sync with reality
      this.isPolling.set(previous);
      const msg = err instanceof Error ? err.message : String(err);
      this.snack.open(`Polling failed: ${msg}`, 'Dismiss', { duration: 5000 });
    }
  }

  // ── Review actions ───────────────────────────────────────────────────────────

  async confirm(item: InvoiceReviewItem): Promise<void> {
    if (item.status === 'saving' || item.status === 'saved') return;
    const settings = this.settings();
    if (!settings) return;

    item.status = 'saving';
    this.items.set([...this.items()]);

    const folder = item.targetFolder
      ?? `${settings.inboxFolder}/${item.invoice.suggestedSubFolder}`;

    const result = await this.outlook.saveAttachment({
      messageId: item.invoice.messageId,
      attachmentId: item.invoice.attachmentId,
      filename: item.invoice.attachmentName,
      subject: item.invoice.subject,
      targetFolder: folder,
    });

    if (result.success) {
      item.status = 'saved';
      item.savedPath = result.filePath;
      item.parsedFields = this.parseFields(result.extractedText, item.invoice.senderName);
    } else {
      item.status = 'pending'; // revert so the action buttons reappear for retry
      item.error = result.error;
      this.snack.open(`Save failed: ${result.error}`, 'Dismiss', { duration: 5000 });
    }

    this.items.set([...this.items()]);
    this.persistQueue();
  }

  reject(item: InvoiceReviewItem): void {
    item.status = 'rejected';
    this.items.set([...this.items()]);
    this.persistQueue();
  }

  async chooseFolder(item: InvoiceReviewItem): Promise<void> {
    const folder = await this.outlook.chooseFolder();
    if (folder) {
      item.targetFolder = folder;
      this.items.set([...this.items()]);
    }
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

  // ── Preview-gated confirmation ─────────────────────────────────────────────────

  /** True once the user has opened this item's source document in the preview pane. */
  hasPreviewed(item: InvoiceReviewItem): boolean {
    return this.previewedKeys().has(this.trackByMessageId(0, item));
  }

  /** A parsed invoice can be confirmed only after its source document has been previewed. */
  canConfirm(item: InvoiceReviewItem): boolean {
    return this.hasPreviewed(item) && !item.reviewConfirmed;
  }

  /** Locks in the parsed fields as user-verified, making the invoice exportable. */
  confirmParsed(item: InvoiceReviewItem): void {
    if (!this.canConfirm(item)) return;
    item.reviewConfirmed = true;
    this.items.set([...this.items()]);
    this.persistQueue();
  }

  /** Re-opens a confirmed invoice for editing (drops it from the exportable set). */
  unconfirmParsed(item: InvoiceReviewItem): void {
    item.reviewConfirmed = false;
    this.items.set([...this.items()]);
    this.persistQueue();
  }

  /**
   * Sets a parsed invoice aside: it drops out of the review/confirmed/all lists and the
   * export, and moves to the Ignored tab. If it was open in the preview, the preview is
   * closed since the row is leaving the list. Reversible via {@link restore}.
   */
  ignoreParsed(item: InvoiceReviewItem): void {
    item.ignored = true;
    if (this.trackByMessageId(0, item) === this.selectedKey()) this.closePreview();
    this.items.set([...this.items()]);
    this.persistQueue();
    this.snack.open('Moved to Ignored', undefined, { duration: 2500 });
  }

  /** Brings an ignored invoice back into the review queue. */
  restoreParsed(item: InvoiceReviewItem): void {
    item.ignored = false;
    this.items.set([...this.items()]);
    this.persistQueue();
    this.snack.open('Restored', undefined, { duration: 2500 });
  }

  // ── Parsed-field extraction & export ───────────────────────────────────────────

  /**
   * Parses payee/amount/etc. from a saved PDF's text layer. With no extractable text
   * (non-PDF or image-only PDF) it still returns a blank field set so the invoice shows
   * up in the PDF Parser with empty, editable inputs for manual entry.
   */
  private parseFields(extractedText: string | undefined, senderName: string): ParsedInvoiceFields {
    const s = this.settingsService.getSettings();
    // Always returns a field set — even with no text layer (scanned/image-only PDF, or a
    // non-PDF attachment) the result is all-blank but present, so the invoice still surfaces
    // in the PDF Parser for manual entry and export. parseInvoiceFields handles empty text
    // gracefully and seeds the payee from the email sender name when available.
    return parseInvoiceFields(
      extractedText ?? '',
      {
        companyName: s.companyName,
        iban: s.iban,
        vatNumber: s.vatNumber,
        accountHolder: s.accountHolder,
      },
      senderName,
    );
  }

  /** Updates one editable parsed field after the user corrects it in the review row. */
  updateParsedField(item: InvoiceReviewItem, field: keyof ParsedInvoiceFields, value: string): void {
    if (!item.parsedFields) return;
    if (field === 'amount') {
      const num = parseFloat(value.replace(',', '.'));
      item.parsedFields.amount = Number.isFinite(num) ? num : null;
    } else {
      (item.parsedFields as any)[field] = value.trim() || null;
    }

    if (item.reviewConfirmed) {
      // Editing an already-confirmed invoice: keep it confirmed and on the Confirmed page.
      // Mark it dirty so the row offers a "Confirm changes" action; the actual re-export
      // (clearing `exported`) is deferred until the user confirms those changes.
      this.markDirty(item);
    } else {
      // Editing an unconfirmed invoice in the review queue — a prior export is now stale.
      item.exported = false;
    }
    // New array reference so the derived signals (confirmed/exportable/counts) recompute.
    this.items.set([...this.items()]);
    this.persistQueue();
  }

  /** True while the user has unsaved edits on an already-confirmed invoice. */
  isDirty(item: InvoiceReviewItem): boolean {
    return this.dirtyKeys().has(this.trackByMessageId(0, item));
  }

  private markDirty(item: InvoiceReviewItem): void {
    const key = this.trackByMessageId(0, item);
    this.dirtyKeys.update(keys => (keys.has(key) ? keys : new Set(keys).add(key)));
  }

  private clearDirty(item: InvoiceReviewItem): void {
    const key = this.trackByMessageId(0, item);
    this.dirtyKeys.update(keys => {
      if (!keys.has(key)) return keys;
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
  }

  /**
   * Confirms edits made to an already-confirmed invoice. Shows the "will be exported again"
   * notice (unless the user opted out), then keeps the invoice confirmed and clears its
   * `exported` flag so it re-enters the next export. Returns true once applied, false if the
   * user cancelled the notice.
   */
  async confirmEdits(item: InvoiceReviewItem): Promise<boolean> {
    if (!this.shouldSkipReexportNotice()) {
      const ref = this.dialog.open<EditConfirmDialogComponent, void, EditConfirmResult | undefined>(
        EditConfirmDialogComponent,
        { width: '440px' },
      );
      const res = await firstValueFrom(ref.afterClosed());
      if (!res) return false; // cancelled — leave the row dirty so the user can retry
      if (res.dontShowAgain) this.setSkipReexportNotice();
    }

    this.clearDirty(item);
    item.exported = false;       // re-export on the next Excel export
    item.reviewConfirmed = true; // stays confirmed
    this.items.set([...this.items()]);
    this.persistQueue();
    return true;
  }

  private shouldSkipReexportNotice(): boolean {
    try { return localStorage.getItem(OutlookInboxStore.REEXPORT_NOTICE_KEY) === '1'; }
    catch { return false; }
  }

  private setSkipReexportNotice(): void {
    try { localStorage.setItem(OutlookInboxStore.REEXPORT_NOTICE_KEY, '1'); }
    catch { /* private mode / quota — fall back to always showing the notice */ }
  }

  /**
   * Exports the confirmed-but-not-yet-exported invoices to BOTH an Excel sheet and a
   * SEPA pain.001 XML file in one action — the Excel sheet is the human-readable record,
   * the XML is what you upload to online banking. The user picks a save location for each.
   *
   * Rows are flagged "exported" only once both files are written. The Excel sheet
   * contains every row, so SEPA legitimately skipping a row (missing IBAN/amount, non-EUR)
   * never loses it; if either step is cancelled, nothing is flagged so the whole export
   * can be retried cleanly.
   */
  async exportBoth(): Promise<void> {
    const rows = this.exportableItems();
    if (rows.length === 0) {
      const msg = this.confirmedItems().length > 0
        ? 'All confirmed invoices have already been exported'
        : 'Confirm at least one invoice before exporting';
      this.snack.open(msg, 'Dismiss', { duration: 4000 });
      return;
    }

    // One confirm dialog for the whole operation; unchecking "mark exported" lets the
    // user test the output without flagging anything.
    const ref = this.dialog.open<ExportConfirmDialogComponent, ExportConfirmData, ExportConfirmResult | undefined>(
      ExportConfirmDialogComponent,
      { width: '440px', data: { count: rows.length } },
    );
    const choice = await firstValueFrom(ref.afterClosed());
    if (!choice) return; // cancelled

    // 1) Excel first — it contains every row regardless of SEPA eligibility.
    try {
      await this.excel.exportParsedInvoices(rows);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snack.open(`Excel export cancelled or failed: ${msg}`, 'Dismiss', { duration: 5000 });
      return; // don't proceed to SEPA or flag anything
    }

    // 2) SEPA XML — may skip rows lacking an IBAN/amount (or all of them); those still
    // live in the Excel file. A result with count 0 means nothing was eligible and no
    // file was written, which is not an error.
    let sepa: SepaExportResult | undefined;
    let sepaError = '';
    let sepaCancelled = false;
    try {
      sepa = await this.sepa.exportPayments(rows, this.settingsService.getSettings());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sepaCancelled = msg === 'Export cancelled';
      sepaError = sepaCancelled ? 'SEPA step cancelled' : `SEPA export failed: ${msg}`;
    }

    // Excel is the authoritative record and it succeeded, so flag the rows when the user
    // opted in. The only case we hold off is a *cancelled* SEPA save — the user likely
    // wants to retry that. No eligible rows, or a SEPA config error, still flags: the
    // Excel sheet holds every row, and otherwise these invoices could never leave the list.
    if (choice.markExported && !sepaCancelled) {
      rows.forEach(r => (r.exported = true));
      this.items.set([...this.items()]);
      this.persistQueue();
    }

    if (sepa && sepa.count > 0) {
      const skippedNote = sepa.skipped.length
        ? ` — ${sepa.skipped.length} not in SEPA file (missing IBAN/amount or non-EUR)`
        : '';
      this.snack.open(
        `Exported ${rows.length} to Excel and ${sepa.count} payment(s) (€${sepa.total.toFixed(2)}) to SEPA XML${skippedNote}`,
        skippedNote ? 'OK' : undefined,
        { duration: skippedNote ? 7000 : 4000 },
      );
    } else if (sepa) {
      // Excel written, but no invoice had a valid IBAN/EUR amount — no XML file created.
      this.snack.open(
        `Exported ${rows.length} to Excel. No SEPA file — no invoice had a valid IBAN and EUR amount.`,
        'OK',
        { duration: 6000 },
      );
    } else {
      // SEPA threw (cancelled or a config error such as a missing company IBAN); Excel
      // still succeeded. Rows are flagged unless the save was cancelled.
      this.snack.open(`Exported ${rows.length} to Excel. ${sepaError}.`, 'Dismiss', { duration: 6000 });
    }
  }

  fieldConfidenceColor(level: string | undefined): 'accent' | 'warn' | undefined {
    if (level === 'medium') return 'accent';
    if (level === 'low') return 'warn';
    return undefined;
  }

  /**
   * Loads an invoice into the side-by-side preview pane. PDFs render in-app via a Blob URL
   * (same-origin, no file:// access); .docx opens in the OS default viewer instead, since
   * Chromium can't render Word documents.
   */
  async selectForPreview(item: InvoiceReviewItem): Promise<void> {
    const key = this.trackByMessageId(0, item);
    this.selectedKey.set(key);
    // Opening the document counts as reviewing it — this unlocks the Confirm action.
    this.previewedKeys.update(keys => new Set(keys).add(key));
    this.clearPreview();

    if (!item.savedPath) {
      this.previewMessage.set('This file has not been saved yet.');
      return;
    }

    const lower = item.savedPath.toLowerCase();
    if (lower.endsWith('.pdf')) {
      this.previewLoading.set(true);
      const res = await this.outlook.readSavedFile(item.savedPath);
      this.previewLoading.set(false);
      if (res.success && res.base64) {
        const blob = new Blob([this.base64ToBytes(res.base64)], { type: 'application/pdf' });
        this.previewBlobUrl = URL.createObjectURL(blob);
        // Ask Chromium's built-in PDF viewer to collapse the thumbnail/nav rail so the page
        // fills the pane. Best-effort: Chromium may ignore navpanes/pagemode (Adobe params).
        const viewed = `${this.previewBlobUrl}#toolbar=1&navpanes=0&pagemode=none`;
        this.previewUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(viewed));
      } else {
        this.previewMessage.set(res.error || 'Could not load preview.');
      }
    } else {
      // .docx / .doc / images — hand off to the OS default viewer.
      const res = await this.outlook.openFile(item.savedPath);
      this.previewMessage.set(res.success
        ? 'Opened in your default viewer (in-app preview supports PDFs only).'
        : (res.error || 'Could not open this file.'));
    }
  }

  /** Opens the currently-selected file in the OS default viewer (toolbar action). */
  async openSelectedExternally(): Promise<void> {
    const item = this.selectedItem();
    if (!item?.savedPath) return;
    const res = await this.outlook.openFile(item.savedPath);
    if (!res.success) this.snack.open(`Could not open file: ${res.error}`, 'Dismiss', { duration: 5000 });
  }

  closePreview(): void {
    this.selectedKey.set(null);
    this.clearPreview();
  }

  /** Releases the current Blob URL and resets preview fields (called before each load). */
  private clearPreview(): void {
    if (this.previewBlobUrl) {
      URL.revokeObjectURL(this.previewBlobUrl);
      this.previewBlobUrl = null;
    }
    this.previewUrl.set(null);
    this.previewMessage.set(null);
    this.previewLoading.set(false);
  }

  private base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** Fire-and-forget queue write — non-fatal if it fails. */
  private persistQueue(): void {
    this.outlook.saveQueue(this.items()).catch(() => {});
  }

  private mergeInvoices(invoices: DetectedInvoice[]): void {
    const items = this.items();
    const existingKeys = new Set(
      items.map(i => i.invoice.messageId + '::' + i.invoice.attachmentId),
    );
    const incoming = invoices
      .filter(inv => !existingKeys.has(inv.messageId + '::' + inv.attachmentId))
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    if (incoming.length > 0) {
      this.items.set([...incoming.map(inv => ({ invoice: inv, status: 'pending' as const })), ...items]);
    }
  }
}
