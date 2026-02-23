import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { InvoiceService } from '../../core/services/invoice.service';
import { PdfGeneratorService } from '../../core/services/pdf-gen.service';
import { SettingsService } from '../../core/services/settings.service';
import { Invoice, CompanySettings } from '../../core/models/domain.models';
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
  displayedColumns: string[] = ['invoiceNumber', 'invoiceDate', 'customerName', 'totalGross', 'status', 'actions'];
  
  filterStatus: 'all' | 'draft' | 'finalized' = 'all';

  constructor(
    private invoiceService: InvoiceService,
    private pdfService: PdfGeneratorService,
    private settingsService: SettingsService,
    private router: Router,
    private snackBar: MatSnackBar,
    private translate: TranslateService
  ) {
    this.invoices$ = this.invoiceService.invoices$;
  }

  ngOnInit(): void {
    // Invoices are automatically loaded by the service
  }

  /**
   * Navigate to create invoice
   */
  createInvoice(): void {
    this.router.navigate(['/invoices/create']);
  }

  /**
   * Navigate to edit invoice
   */
  editInvoice(invoice: Invoice): void {
    if (invoice.status === 'finalized') {
      this.showMessage(
        this.translate.instant('INVOICE.STATUS_FINALIZED'),
        'error'
      );
      return;
    }
    this.router.navigate(['/invoices/edit', invoice.id]);
  }

  /**
   * Delete invoice with confirmation
   */
  async deleteInvoice(invoice: Invoice): Promise<void> {
    const confirmed = confirm(this.translate.instant('INVOICE.DELETE_CONFIRM'));
    
    if (confirmed) {
      try {
        await this.invoiceService.deleteInvoice(invoice.id);
        this.showMessage(this.translate.instant('MESSAGES.DELETE_SUCCESS'));
      } catch (error) {
        this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
        console.error('Error deleting invoice:', error);
      }
    }
  }

  /**
   * Generate and save PDF
   */
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

  /**
   * Finalize invoice
   */
  async finalizeInvoice(invoice: Invoice): Promise<void> {
    const confirmed = confirm(this.translate.instant('INVOICE.FINALIZE_CONFIRM'));
    
    if (confirmed) {
      try {
        await this.invoiceService.finalizeInvoice(invoice.id);
        this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
      } catch (error) {
        this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
        console.error('Error finalizing invoice:', error);
      }
    }
  }

  /**
   * Filter invoices by status
   */
  getFilteredInvoices(invoices: Invoice[] | null): Invoice[] {
    if (!invoices) return [];
    
    if (this.filterStatus === 'all') {
      return invoices;
    }
    
    return invoices.filter(inv => inv.status === this.filterStatus);
  }

  /**
   * Get status badge class
   */
  getStatusClass(status: string): string {
    return status === 'finalized' ? 'status-finalized' : 'status-draft';
  }

  /**
   * Get status label
   */
  getStatusLabel(status: string): string {
    return status === 'finalized' 
      ? this.translate.instant('INVOICE.STATUS_FINALIZED')
      : this.translate.instant('INVOICE.STATUS_DRAFT');
  }

  /**
   * Format currency
   */
  formatCurrency(value: number): string {
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'EUR'
    }).format(value);
  }

  /**
   * Format date
   */
  formatDate(dateString: string): string {
    const date = new Date(dateString);
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return date.toLocaleDateString(locale);
  }

  /**
   * Show snackbar message
   */
  private showMessage(message: string, type: 'success' | 'error' = 'success'): void {
    this.snackBar.open(message, this.translate.instant('COMMON.CLOSE'), {
      duration: 3000,
      panelClass: type === 'error' ? 'snackbar-error' : 'snackbar-success'
    });
  }
}