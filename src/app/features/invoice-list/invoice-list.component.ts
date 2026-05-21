import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { InvoiceService } from '../../core/services/invoice.service';
import { PdfGeneratorService } from '../../core/services/pdf-gen.service';
import { ExcelExportService } from '../../core/services/excel-export.service';
import { SettingsService } from '../../core/services/settings.service';
import { Invoice } from '../../core/models/domain.models';
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

  constructor(
    private invoiceService: InvoiceService,
    private pdfService: PdfGeneratorService,
    private excelExportService: ExcelExportService,
    private settingsService: SettingsService,
    private router: Router,
    private snackBar: MatSnackBar,
    private translate: TranslateService
  ) {
    this.invoices$ = this.invoiceService.invoices$;
    this.invoices$.subscribe(invs => this.allInvoices = invs ?? []);
  }

  getAvailableYears(): number[] {
    const years = new Set<number>();
    for (const inv of this.allInvoices) {
      if (inv.invoiceNumber && inv.invoiceNumber.length >= 2) {
        const yy = parseInt(inv.invoiceNumber.substring(0, 2), 10);
        if (!isNaN(yy)) years.add(2000 + yy);
      }
    }
    return Array.from(years).sort((a, b) => b - a);
  }

  async exportYear(): Promise<void> {
    if (!this.filterYear) return;
    const yearInvoices = this.allInvoices.filter(inv => {
      const yy = parseInt(inv.invoiceNumber?.substring(0, 2) ?? '', 10);
      return 2000 + yy === this.filterYear;
    });
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

  ngOnInit(): void { }

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

  /**
   * Filter by status AND search query (invoice number or customer name)
   */
  getFilteredInvoices(invoices: Invoice[] | null): Invoice[] {
    if (!invoices) return [];

    let result = invoices;

    // Year filter
    if (this.filterYear !== null) {
      result = result.filter(inv => {
        const yy = parseInt(inv.invoiceNumber?.substring(0, 2) ?? '', 10);
        return 2000 + yy === this.filterYear;
      });
    }

    // Status filter
    if (this.filterStatus !== 'all') {
      result = result.filter(inv => inv.status === this.filterStatus);
    }

    // Search filter
    const q = this.searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(inv =>
        inv.invoiceNumber?.toLowerCase().includes(q) ||
        inv.customerName?.toLowerCase().includes(q)
      );
    }

    // Newest first — credit notes (026G) always sit directly after their parent (026)
    result = [...result].sort((a, b) => {
      const baseA = (a.invoiceNumber ?? '').replace(/G$/i, '').replace(/\D/g, '');
      const baseB = (b.invoiceNumber ?? '').replace(/G$/i, '').replace(/\D/g, '');
      const numA = parseInt(baseA || '0', 10);
      const numB = parseInt(baseB || '0', 10);
      if (numA !== numB) return numB - numA;                              // descending
      const isGA = (a.invoiceNumber ?? '').toUpperCase().endsWith('G') ? 1 : 0;
      const isGB = (b.invoiceNumber ?? '').toUpperCase().endsWith('G') ? 1 : 0;
      return isGA - isGB;                                                 // regular before G
    });

    return result;
  }

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
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value);
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return date.toLocaleDateString(locale);
  }

  private showMessage(message: string, type: 'success' | 'error' = 'success'): void {
    this.snackBar.open(message, this.translate.instant('COMMON.CLOSE'), {
      duration: 3000,
      panelClass: type === 'error' ? 'snackbar-error' : 'snackbar-success'
    });
  }
}