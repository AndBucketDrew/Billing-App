import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { InvoiceService } from '../../core/services/invoice.service';
import { PdfGeneratorService } from '../../core/services/pdf-gen.service';
import { ExcelExportService } from '../../core/services/excel-export.service';
import { SettingsService } from '../../core/services/settings.service';
import { ElectronService } from '../../core/services/electron.service';
import { InvoiceEmailService } from '../../core/services/invoice-email.service';
import { InvoiceFilterService } from '../../core/services/invoice-filter.service';
import { Invoice } from '../../core/models/domain.models';
import { formatCurrencyEUR, formatDateLocalized } from '../../core/utils/format.util';
import { Observable } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-invoice-list',
  templateUrl: './invoice-list.component.html',
  styleUrls: ['./invoice-list.component.scss'],
  standalone: false,
})
export class InvoiceListComponent implements OnInit {
  invoices$: Observable<Invoice[]>;
  allInvoices: Invoice[] = [];
  displayedColumns: string[] = ['invoiceNumber', 'invoiceDate', 'customerName', 'totalGross', 'status', 'actions'];

  filterStatus: 'all' | 'draft' | 'finalized' = 'all';
  filterYear: number | null = null;
  searchQuery: string = '';
  isExporting = false;

  /** True when the last load threw — distinguishes "couldn't load" from "no invoices yet". */
  readonly loadFailed$ = inject(InvoiceService).loadFailed$;

  constructor(
    private invoiceService: InvoiceService,
    private pdfService: PdfGeneratorService,
    private excelExportService: ExcelExportService,
    private settingsService: SettingsService,
    private electron: ElectronService,
    private emailService: InvoiceEmailService,
    private filterService: InvoiceFilterService,
    private router: Router,
    private snackBar: MatSnackBar,
    private translate: TranslateService,
    private destroyRef: DestroyRef
  ) {
    this.invoices$ = this.invoiceService.invoices$;
    this.invoices$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(invs => this.allInvoices = invs ?? []);
  }

  ngOnInit(): void { }

  // ── Filtering (delegates to InvoiceFilterService) ────────────────────────────

  getAvailableYears(): number[] {
    return this.filterService.getAvailableYears(this.allInvoices);
  }

  getFilteredInvoices(invoices: Invoice[] | null): Invoice[] {
    return this.filterService.filter(invoices, {
      year: this.filterYear,
      status: this.filterStatus,
      search: this.searchQuery,
    });
  }

  async exportYear(): Promise<void> {
    if (!this.filterYear) return;
    const yearInvoices = this.filterService.filterByYear(this.allInvoices, this.filterYear);
    this.isExporting = true;
    try {
      await this.excelExportService.exportYearToExcel(yearInvoices, this.filterYear);
      this.showMessage(`Exported ${yearInvoices.length} invoices for ${this.filterYear}`);
    } catch (error: any) {
      if (!error?.message?.includes('cancelled')) {
        this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      }
    } finally {
      this.isExporting = false;
    }
  }

  // ── Invoice actions ──────────────────────────────────────────────────────────

  createInvoice(): void {
    this.router.navigate(['/invoices/create']);
  }

  editInvoice(invoice: Invoice): void {
    if (invoice.status !== 'draft') {
      this.showMessage(this.translate.instant('INVOICE.STATUS_FINALIZED'), 'error');
      return;
    }
    this.router.navigate(['/invoices/edit', invoice.id]);
  }

  async deleteInvoice(invoice: Invoice): Promise<void> {
    if (!confirm(this.translate.instant('INVOICE.DELETE_CONFIRM'))) return;
    try {
      await this.invoiceService.deleteInvoice(invoice.id);
      this.showMessage(this.translate.instant('MESSAGES.DELETE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error deleting invoice:', error);
    }
  }

  async generatePDF(invoice: Invoice): Promise<void> {
    try {
      const settings = this.settingsService.getSettings();
      await this.pdfService.generateInvoicePDF(invoice, settings);
      this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error generating PDF:', error);
    }
  }

  async finalizeInvoice(invoice: Invoice): Promise<void> {
    if (!confirm(this.translate.instant('INVOICE.FINALIZE_CONFIRM'))) return;
    try {
      await this.invoiceService.finalizeInvoice(invoice.id);
      this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error finalizing invoice:', error);
    }
  }

  async togglePaid(invoice: Invoice): Promise<void> {
    const confirmKey = invoice.isPaid ? 'INVOICE.MARK_UNPAID_CONFIRM' : 'INVOICE.MARK_PAID_CONFIRM';
    if (!confirm(this.translate.instant(confirmKey))) return;
    try {
      await this.invoiceService.togglePaid(invoice);
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error toggling paid status:', error);
    }
  }

  async createCreditNote(invoice: Invoice): Promise<void> {
    const msg = this.translate.instant('INVOICE.CREATE_CREDIT_NOTE_CONFIRM', {
      invoiceNumber: invoice.invoiceNumber
    });
    if (!confirm(msg)) return;
    try {
      await this.invoiceService.createCreditNote(invoice);
      this.showMessage(this.translate.instant('INVOICE.CREDIT_NOTE_CREATED'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error creating credit note:', error);
    }
  }

  async sendMail(invoice: Invoice): Promise<void> {
    const settings = this.settingsService.getSettings();

    let pdfBase64: string;
    try {
      pdfBase64 = await this.pdfService.getInvoicePdfBase64(invoice, settings);
    } catch {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      return;
    }

    try {
      await this.electron.api.mail.openDraft({
        to: invoice.customerEmail ?? '',
        subject: this.emailService.buildSubject(invoice, settings),
        body: await this.emailService.buildBody(invoice, settings),
        pdfBase64,
        filename: `${invoice.invoiceNumber}.pdf`,
      });
    } catch (err) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
    }
  }

  // ── View helpers ─────────────────────────────────────────────────────────────

  getStatusClass(status: string): string {
    if (status === 'finalized')  return 'status-finalized';
    if (status === 'storniert')  return 'status-storniert';
    return 'status-draft';
  }

  getStatusLabel(status: string): string {
    if (status === 'finalized')  return this.translate.instant('INVOICE.STATUS_FINALIZED');
    if (status === 'storniert')  return this.translate.instant('INVOICE.STATUS_STORNIERT');
    return this.translate.instant('INVOICE.STATUS_DRAFT');
  }

  isCreditNote(invoice: Invoice): boolean {
    return invoice.type === 'credit_note';
  }

  formatCurrency(value: number): string {
    return formatCurrencyEUR(value, this.translate.currentLang);
  }

  formatDate(dateString: string): string {
    return formatDateLocalized(dateString, this.translate.currentLang);
  }

  private showMessage(message: string, type: 'success' | 'error' = 'success'): void {
    this.snackBar.open(message, this.translate.instant('COMMON.CLOSE'), {
      duration: 3000,
      panelClass: type === 'error' ? 'snackbar-error' : 'snackbar-success'
    });
  }
}
