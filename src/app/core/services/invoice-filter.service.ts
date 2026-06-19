/**
 * InvoiceFilterService — pure list operations for the invoice table:
 * deriving available years, filtering by year/status/search, and the
 * custom sort order. Extracted from InvoiceListComponent so the component
 * only holds the filter *state* (the bound values) and delegates the logic.
 */

import { Injectable } from '@angular/core';
import { Invoice } from '../models/domain.models';

export interface InvoiceFilterCriteria {
  year: number | null;
  status: 'all' | 'draft' | 'finalized';
  search: string;
}

@Injectable({ providedIn: 'root' })
export class InvoiceFilterService {
  /** Years (e.g. 2026) derived from the leading "YY" of each invoice number. */
  getAvailableYears(invoices: Invoice[]): number[] {
    const years = new Set<number>();
    for (const inv of invoices) {
      if (inv.invoiceNumber && inv.invoiceNumber.length >= 2) {
        const yy = parseInt(inv.invoiceNumber.substring(0, 2), 10);
        if (!isNaN(yy)) years.add(2000 + yy);
      }
    }
    return Array.from(years).sort((a, b) => b - a);
  }

  /** Invoices whose number's leading "YY" maps to the given calendar year. */
  filterByYear(invoices: Invoice[], year: number): Invoice[] {
    return invoices.filter(inv => {
      const yy = parseInt(inv.invoiceNumber?.substring(0, 2) ?? '', 10);
      return !isNaN(yy) && 2000 + yy === year;
    });
  }

  /** Applies year + status + search filters, then the display sort order. */
  filter(invoices: Invoice[] | null, criteria: InvoiceFilterCriteria): Invoice[] {
    if (!invoices) return [];

    let result = invoices;

    if (criteria.year !== null) {
      result = this.filterByYear(result, criteria.year);
    }

    if (criteria.status !== 'all') {
      result = result.filter(inv => inv.status === criteria.status);
    }

    const q = criteria.search.trim().toLowerCase();
    if (q) {
      result = result.filter(inv =>
        inv.invoiceNumber?.toLowerCase().includes(q) ||
        inv.customerName?.toLowerCase().includes(q)
      );
    }

    return this.sort(result);
  }

  /**
   * Drafts (no number yet) always float to the top; then newest first;
   * credit notes (026G) always sit directly after their parent (026).
   */
  private sort(invoices: Invoice[]): Invoice[] {
    return [...invoices].sort((a, b) => {
      const aIsDraft = !a.invoiceNumber;
      const bIsDraft = !b.invoiceNumber;
      if (aIsDraft !== bIsDraft) return aIsDraft ? -1 : 1;             // drafts first

      const baseA = (a.invoiceNumber ?? '').replace(/G$/i, '').replace(/\D/g, '');
      const baseB = (b.invoiceNumber ?? '').replace(/G$/i, '').replace(/\D/g, '');
      const numA = parseInt(baseA || '0', 10);
      const numB = parseInt(baseB || '0', 10);
      if (numA !== numB) return numB - numA;                            // descending
      const isGA = (a.invoiceNumber ?? '').toUpperCase().endsWith('G') ? 1 : 0;
      const isGB = (b.invoiceNumber ?? '').toUpperCase().endsWith('G') ? 1 : 0;
      return isGA - isGB;                                               // regular before G
    });
  }
}
