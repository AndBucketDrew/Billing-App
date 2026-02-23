import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronService } from './electron.service';
import { CalculationService } from './calculation.service';
import type { Invoice, InvoiceLineItem, VatRate } from '../models/domain.models';
import { v4 as uuidv4 } from 'uuid';

@Injectable({
  providedIn: 'root'
})
export class InvoiceService {
  private invoicesSubject = new BehaviorSubject<Invoice[]>([]);
  public invoices$: Observable<Invoice[]> = this.invoicesSubject.asObservable();

  constructor(
    private electron: ElectronService,
    private calculation: CalculationService
  ) {
    this.loadInvoices();
  }

  async loadInvoices(): Promise<void> {
    try {
      const invoices = await this.electron.api.invoice.getAll();
      this.invoicesSubject.next(invoices);
    } catch (error) {
      console.error('Error loading invoices:', error);
      throw error;
    }
  }

  getInvoices(): Invoice[] {
    return this.invoicesSubject.value;
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    try {
      return await this.electron.api.invoice.getById(id);
    } catch (error) {
      console.error('Error getting invoice:', error);
      throw error;
    }
  }

  async createInvoice(invoiceData: {
    invoiceDate: string;
    customerName: string;
    customerAddress: string;
    customerEmail?: string | null;
    companyName?: string | null;
    companyAddress?: string | null;
    companyCityCountry?: string | null;
    tourDate?: string | null;
    pax?: number | null;
    guide?: string | null;
    language: 'de' | 'en';
    lineItems: InvoiceLineItem[];
  }): Promise<Invoice> {
    try {
      const totals = this.calculation.calculateInvoiceTotals(invoiceData.lineItems);

      const payload: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'> = {
        ...invoiceData,
        invoiceNumber: this.generateInvoiceNumber(),
        status: 'draft',
        vatBreakdown: totals.vatBreakdown,
        totalNet: totals.totalNet,
        totalVat: totals.totalVat,
        totalGross: totals.totalGross
      };

      const newInvoice = await this.electron.api.invoice.create(payload);

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

      const updated = await this.electron.api.invoice.update(id, updates);
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
      const success = await this.electron.api.invoice.delete(id);
      if (success) {
        await this.loadInvoices();
      }
      return success;
    } catch (error) {
      console.error('Error deleting invoice:', error);
      throw error;
    }
  }

  async finalizeInvoice(id: string): Promise<Invoice | null> {
    return this.updateInvoice(id, { status: 'finalized' });
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

  private generateInvoiceNumber(): string {
    const now = new Date();

    const pad = (n: number, length = 2): string =>
      String(n).padStart(length, '0');

    const yy  = String(now.getFullYear()).slice(-2);
    const mm  = pad(now.getMonth() + 1);
    const dd  = pad(now.getDate());
    const hh  = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss  = pad(now.getSeconds());
    const ms  = String(now.getMilliseconds())[0];

    return `${yy}${mm}${dd}-${hh}${min}${ss}-${ms}`;
  }
}