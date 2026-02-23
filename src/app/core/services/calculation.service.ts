import { Injectable } from '@angular/core';
import type { 
  InvoiceLineItem, 
  VatBreakdownItem, 
  VatRate 
} from '../models/domain.models';

export interface InvoiceTotals {
  vatBreakdown: VatBreakdownItem[];
  totalNet: number;
  totalVat: number;
  totalGross: number;
}

@Injectable({
  providedIn: 'root'
})
export class CalculationService {

  /**
   * Calculate line item totals
   */
  calculateLineItem(
    quantity: number, 
    unitPriceNet: number, 
    vatPercentage: VatRate
  ): Pick<InvoiceLineItem, 'lineTotalNet' | 'lineTotalVat' | 'lineTotalGross'> {
    const lineTotalNet = this.round(quantity * unitPriceNet);
    const lineTotalVat = this.round(lineTotalNet * (vatPercentage / 100));
    const lineTotalGross = this.round(lineTotalNet + lineTotalVat);

    return {
      lineTotalNet,
      lineTotalVat,
      lineTotalGross
    };
  }

  /**
   * Calculate invoice totals with VAT breakdown
   */
  calculateInvoiceTotals(lineItems: InvoiceLineItem[]): InvoiceTotals {
    // Group line items by VAT percentage
    const vatGroups = new Map<VatRate, InvoiceLineItem[]>();
    
    lineItems.forEach(item => {
      const existing = vatGroups.get(item.vatPercentage) || [];
      existing.push(item);
      vatGroups.set(item.vatPercentage, existing);
    });

    // Calculate breakdown for each VAT rate
    const vatBreakdown: VatBreakdownItem[] = [];
    
    vatGroups.forEach((items, vatPercentage) => {
      const netTotal = this.round(
        items.reduce((sum, item) => sum + item.lineTotalNet, 0)
      );
      const vatAmount = this.round(
        items.reduce((sum, item) => sum + item.lineTotalVat, 0)
      );
      const grossTotal = this.round(netTotal + vatAmount);

      vatBreakdown.push({
        vatPercentage,
        netTotal,
        vatAmount,
        grossTotal
      });
    });

    // Sort by VAT percentage for consistent display
    vatBreakdown.sort((a, b) => a.vatPercentage - b.vatPercentage);

    // Calculate totals
    const totalNet = this.round(
      vatBreakdown.reduce((sum, item) => sum + item.netTotal, 0)
    );
    const totalVat = this.round(
      vatBreakdown.reduce((sum, item) => sum + item.vatAmount, 0)
    );
    const totalGross = this.round(
      vatBreakdown.reduce((sum, item) => sum + item.grossTotal, 0)
    );

    return {
      vatBreakdown,
      totalNet,
      totalVat,
      totalGross
    };
  }

  /**
   * Round to 2 decimal places (for currency)
   */
  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * Format currency for display
   */
  formatCurrency(value: number, locale: string = 'de-DE'): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
  }

  /**
   * Get VAT label translation key
   */
  getVatLabelKey(vatRate: VatRate, language: 'de' | 'en'): string {
    if (vatRate === 0) {
      return language === 'de' 
        ? 'INVOICE.VAT_REVERSED' 
        : 'INVOICE.VAT_REVERSED';
    }
    return 'INVOICE.NET_TOTAL';
  }
}