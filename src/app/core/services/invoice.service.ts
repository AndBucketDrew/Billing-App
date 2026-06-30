import { Injectable, Inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { DATA_GATEWAY, DataGateway } from '../data/data-gateway';
import { CalculationService } from './calculation.service';
import { ConnectionStatusService } from './connection-status.service';
import type { Invoice, InvoiceLineItem, InvoiceType, PaymentMethod, VatRate } from '../models/domain.models';
import { v4 as uuidv4 } from 'uuid';

@Injectable({
  providedIn: 'root'
})
export class InvoiceService {
  private invoicesSubject = new BehaviorSubject<Invoice[]>([]);
  public invoices$: Observable<Invoice[]> = this.invoicesSubject.asObservable();

  /**
   * True when the last load threw — for ANY reason, not just connectivity. Lets the
   * list distinguish "couldn't load" from "genuinely empty"; the connection offline
   * banner only covers network-style failures, so a 5xx/RLS error would otherwise
   * fall through to a misleading "no invoices yet" empty state.
   */
  private loadFailedSubject = new BehaviorSubject<boolean>(false);
  public loadFailed$: Observable<boolean> = this.loadFailedSubject.asObservable();

  constructor(
    @Inject(DATA_GATEWAY) private data: DataGateway,
    private calculation: CalculationService,
    private connection: ConnectionStatusService,
  ) {
    this.loadInvoices();
  }

  async loadInvoices(): Promise<void> {
    try {
      const invoices = await this.data.invoice.getAll();
      this.invoicesSubject.next(invoices);
      this.loadFailedSubject.next(false);
      this.connection.reportSuccess();
    } catch (error) {
      console.error('Error loading invoices:', error);
      this.loadFailedSubject.next(true);
      this.connection.reportError(error);
      throw error;
    }
  }

  getInvoices(): Invoice[] {
    return this.invoicesSubject.value;
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    try {
      return await this.data.invoice.getById(id);
    } catch (error) {
      console.error('Error getting invoice:', error);
      throw error;
    }
  }

  async createInvoice(invoiceData: {
    invoiceDate: string;
    salutation?: 'herr' | 'frau' | 'divers' | null;
    customerName: string;
    customerAddress: string;
    customerEmail?: string | null;
    companyName?: string | null;
    companyAddress?: string | null;
    companyCityCountry?: string | null;
    tourDate?: string | null;
    meetingPoint?: string | null;
    pax?: number | null;
    guide?: string | null;
    civitatisId?: string | null;
    paymentMethod?: PaymentMethod | null;
    language: 'de' | 'en';
    lineItems: InvoiceLineItem[];
  }): Promise<Invoice> {
    try {
      const totals = this.calculation.calculateInvoiceTotals(invoiceData.lineItems);

      // invoiceNumber is intentionally omitted — the main process sets it to null on
      // creation and only assigns a real number atomically at finalization.
      const payload: Omit<Invoice, 'id' | 'invoiceNumber' | 'createdAt' | 'updatedAt'> = {
        ...invoiceData,
        salutation: invoiceData.salutation ?? null,
        status: 'draft',
        vatBreakdown: totals.vatBreakdown,
        totalNet: totals.totalNet,
        totalVat: totals.totalVat,
        totalGross: totals.totalGross
      };

      const newInvoice = await this.data.invoice.create(payload);
      await this.loadInvoices();
      return newInvoice;
    } catch (error) {
      console.error('Error creating invoice:', error);
      throw error;
    }
  }

  async updateInvoice(id: string, updates: Partial<Invoice>): Promise<Invoice | null> {
    try {
      if (updates.lineItems) {
        const totals = this.calculation.calculateInvoiceTotals(updates.lineItems);
        updates.vatBreakdown = totals.vatBreakdown;
        updates.totalNet = totals.totalNet;
        updates.totalVat = totals.totalVat;
        updates.totalGross = totals.totalGross;
      }

      const updated = await this.data.invoice.update(id, updates);
      if (updated) {
        await this.loadInvoices();
      }
      return updated;
    } catch (error) {
      console.error('Error updating invoice:', error);
      throw error;
    }
  }

  async deleteInvoice(id: string): Promise<boolean> {
    try {
      const success = await this.data.invoice.delete(id);
      if (success) {
        await this.loadInvoices();
      }
      return success;
    } catch (error) {
      console.error('Error deleting invoice:', error);
      throw error;
    }
  }

  /**
   * Atomically assigns an invoice number (from the settings counter) and flips the
   * status to 'finalized'.  The number generation and the status update happen in a
   * single write on the main process — no counter drift and no partial state.
   */
  async finalizeInvoice(id: string): Promise<Invoice | null> {
    try {
      const finalized = await this.data.invoice.finalize(id);
      if (finalized) {
        await this.loadInvoices();
      }
      return finalized;
    } catch (error) {
      console.error('Error finalizing invoice:', error);
      throw error;
    }
  }

  /**
   * Atomically creates a Gutschrift (credit note) that mirrors the original invoice
   * with all amounts negated, AND marks the original as 'storniert' — both changes
   * land in a single writeJsonFile call so a crash cannot leave them inconsistent.
   */
  async createCreditNote(originalInvoice: Invoice): Promise<Invoice> {
    try {
      // Negate every line item so the credit note cancels the original
      const creditLineItems: InvoiceLineItem[] = originalInvoice.lineItems.map(item => ({
        ...item,
        id: uuidv4(),
        quantity: -Math.abs(item.quantity),
        lineTotalNet: -Math.abs(item.lineTotalNet),
        lineTotalVat: -Math.abs(item.lineTotalVat),
        lineTotalGross: -Math.abs(item.lineTotalGross),
      }));

      const totals = this.calculation.calculateInvoiceTotals(creditLineItems);

      // Destructure away the original's id/timestamps so the main process assigns new ones
      const { id: _id, createdAt: _ca, updatedAt: _ua, ...rest } = originalInvoice;

      const payload: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'> = {
        ...rest,
        // Credit note number is derived from the original — it does NOT consume a counter slot
        invoiceNumber: (originalInvoice.invoiceNumber ?? '') + 'G',
        type: 'credit_note' as InvoiceType,
        creditNoteForInvoiceNumber: originalInvoice.invoiceNumber,
        status: 'draft' as const,
        lineItems: creditLineItems,
        vatBreakdown: totals.vatBreakdown,
        totalNet: totals.totalNet,
        totalVat: totals.totalVat,
        totalGross: totals.totalGross,
      };

      const newInvoice = await this.data.invoice.createCreditNote(originalInvoice.id, payload);
      await this.loadInvoices();
      return newInvoice;
    } catch (error) {
      console.error('Error creating credit note:', error);
      throw error;
    }
  }

  async togglePaid(invoice: Invoice): Promise<Invoice | null> {
    return this.updateInvoice(invoice.id, { isPaid: !invoice.isPaid });
  }

  createLineItem(data: {
    tourId?: string;
    description: string;
    quantity: number;
    unitPriceNet: number;
    vatPercentage: VatRate;
    sortOrder: number;
  }): InvoiceLineItem {
    const totals = this.calculation.calculateLineItem(
      data.quantity,
      data.unitPriceNet,
      data.vatPercentage
    );

    return {
      id: uuidv4(),
      tourId: data.tourId,
      description: data.description,
      quantity: data.quantity,
      unitPriceNet: data.unitPriceNet,
      vatPercentage: data.vatPercentage,
      sortOrder: data.sortOrder,
      ...totals
    };
  }

  recalculateLineItem(item: InvoiceLineItem): InvoiceLineItem {
    const totals = this.calculation.calculateLineItem(
      item.quantity,
      item.unitPriceNet,
      item.vatPercentage
    );

    return { ...item, ...totals };
  }
}
