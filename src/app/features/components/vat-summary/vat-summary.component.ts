import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CalculationService, InvoiceTotals } from '../../../core/services/calculation.service';
import { InvoiceLineItem } from '../../../core/models/domain.models';
import { TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-vat-summary',
  templateUrl: './vat-summary.component.html',
  styleUrls: ['./vat-summary.component.scss'],
  standalone: false,
})
export class VatSummaryComponent implements OnChanges {
  @Input() lineItems: InvoiceLineItem[] = [];
  @Input() language: 'de' | 'en' = 'de';

  totals: InvoiceTotals | null = null;

  constructor(
    private calculationService: CalculationService,
    private translate: TranslateService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['lineItems']) {
      this.calculateTotals();
    }
  }

  /**
   * Calculate invoice totals with VAT breakdown
   */
  calculateTotals(): void {
    if (this.lineItems.length === 0) {
      this.totals = null;
      return;
    }

    this.totals = this.calculationService.calculateInvoiceTotals(this.lineItems);
  }

  /**
   * Format currency
   */
  formatCurrency(value: number): string {
    return this.calculationService.formatCurrency(value, this.getLocale());
  }

  /**
   * Get locale string
   */
  getLocale(): string {
    return this.language === 'de' ? 'de-DE' : 'en-US';
  }

  /**
   * Get VAT label for display
   */
  getVatLabel(vatRate: number): string {
    if (vatRate === 0) {
      return this.translate.instant('INVOICE.VAT_REVERSED');
    }
    return this.translate.instant('INVOICE.NET_TOTAL', { vat: vatRate });
  }

  /**
   * Get VAT amount label
   */
  getVatAmountLabel(vatRate: number): string {
    if (vatRate === 0) {
      return ''; // Don't show VAT amount for reverse charge
    }
    return this.translate.instant('INVOICE.VAT_AMOUNT', { vat: vatRate });
  }

  /**
   * Check if should show VAT amount row
   */
  shouldShowVatAmount(vatRate: number): boolean {
    return vatRate !== 0;
  }
}