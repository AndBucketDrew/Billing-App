import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { API_BASE } from './auth.service';
import { BillingInvoiceDto, AddBillingInvoiceRequest } from '../models/api.models';
import { CalculationService } from './calculation.service';
import type { Invoice, InvoiceLineItem, PaymentMethod, VatRate } from '../models/domain.models';

@Injectable({
  providedIn: 'root'
})
export class InvoiceService {
  private invoicesSubject = new BehaviorSubject<Invoice[]>([]);
  public invoices$: Observable<Invoice[]> = this.invoicesSubject.asObservable();

  constructor(
    private http: HttpClient,
    private calculation: CalculationService
  ) {
    this.loadInvoices();
  }

  async loadInvoices(): Promise<void> {
    try {
      const dtos = await firstValueFrom(
        this.http.get<BillingInvoiceDto[]>(`${API_BASE}/api/BillingInvoice`)
      );
      this.invoicesSubject.next(dtos.map(d => this.toInvoice(d)));
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
      const dto = await firstValueFrom(
        this.http.get<BillingInvoiceDto>(`${API_BASE}/api/BillingInvoice/${id}`)
      );
      return this.toInvoice(dto);
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
    companyTaxId?: string | null;
    companyCustomerName?: string | null;
    purchaseOrderNumber?: string | null;
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
      const body: AddBillingInvoiceRequest = {
        invoiceDate: invoiceData.invoiceDate,
        salutation: invoiceData.salutation ?? undefined,
        customerName: invoiceData.customerName,
        customerAddress: invoiceData.customerAddress,
        customerEmail: invoiceData.customerEmail ?? undefined,
        companyName: invoiceData.companyName ?? undefined,
        companyAddress: invoiceData.companyAddress ?? undefined,
        companyCityCountry: invoiceData.companyCityCountry ?? undefined,
        companyTaxId: invoiceData.companyTaxId ?? undefined,
        companyCustomerName: invoiceData.companyCustomerName ?? undefined,
        purchaseOrderNumber: invoiceData.purchaseOrderNumber ?? undefined,
        tourDate: invoiceData.tourDate ?? undefined,
        meetingPoint: invoiceData.meetingPoint ?? undefined,
        pax: invoiceData.pax ?? undefined,
        guide: invoiceData.guide ?? undefined,
        civitatisId: invoiceData.civitatisId ?? undefined,
        paymentMethod: invoiceData.paymentMethod ? this.toApiPaymentMethod(invoiceData.paymentMethod) : undefined,
        language: invoiceData.language,
        lineItems: invoiceData.lineItems.map(li => ({
          tenantProductId: li.tourId ?? undefined,
          description: li.description,
          quantity: li.quantity,
          unitPriceNet: li.unitPriceNet,
          vatPercentage: li.vatPercentage,
          sortOrder: li.sortOrder
        }))
      };

      const dto = await firstValueFrom(
        this.http.post<BillingInvoiceDto>(`${API_BASE}/api/BillingInvoice`, body)
      );
      await this.loadInvoices();
      return this.toInvoice(dto);
    } catch (error) {
      console.error('Error creating invoice:', error);
      throw error;
    }
  }

  async updateInvoice(id: string, updates: Partial<Invoice>): Promise<Invoice | null> {
    try {
      const current = await this.getInvoiceById(id);
      if (!current) return null;

      const merged = { ...current, ...updates };

      const body: AddBillingInvoiceRequest = {
        invoiceDate: merged.invoiceDate,
        salutation: merged.salutation ?? undefined,
        customerName: merged.customerName,
        customerAddress: merged.customerAddress,
        customerEmail: merged.customerEmail ?? undefined,
        companyName: merged.companyName ?? undefined,
        companyAddress: merged.companyAddress ?? undefined,
        companyCityCountry: merged.companyCityCountry ?? undefined,
        companyTaxId: merged.companyTaxId ?? undefined,
        companyCustomerName: merged.companyCustomerName ?? undefined,
        purchaseOrderNumber: merged.purchaseOrderNumber ?? undefined,
        tourDate: merged.tourDate ?? undefined,
        meetingPoint: merged.meetingPoint ?? undefined,
        pax: merged.pax ?? undefined,
        guide: merged.guide ?? undefined,
        civitatisId: merged.civitatisId ?? undefined,
        paymentMethod: merged.paymentMethod ? this.toApiPaymentMethod(merged.paymentMethod) : undefined,
        language: merged.language,
        lineItems: merged.lineItems.map(li => ({
          tenantProductId: li.tourId ?? undefined,
          description: li.description,
          quantity: li.quantity,
          unitPriceNet: li.unitPriceNet,
          vatPercentage: li.vatPercentage,
          sortOrder: li.sortOrder
        }))
      };

      const dto = await firstValueFrom(
        this.http.put<BillingInvoiceDto>(`${API_BASE}/api/BillingInvoice/${id}`, body)
      );
      await this.loadInvoices();
      return this.toInvoice(dto);
    } catch (error) {
      console.error('Error updating invoice:', error);
      throw error;
    }
  }

  async deleteInvoice(id: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.delete(`${API_BASE}/api/BillingInvoice/${id}`));
      await this.loadInvoices();
      return true;
    } catch (error) {
      console.error('Error deleting invoice:', error);
      throw error;
    }
  }

  async finalizeInvoice(id: string): Promise<Invoice | null> {
    try {
      const dto = await firstValueFrom(
        this.http.patch<BillingInvoiceDto>(`${API_BASE}/api/BillingInvoice/${id}/finalize`, {})
      );
      await this.loadInvoices();
      return this.toInvoice(dto);
    } catch (error) {
      console.error('Error finalizing invoice:', error);
      throw error;
    }
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
      id: crypto.randomUUID(),
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

  private toInvoice(dto: BillingInvoiceDto): Invoice {
    return {
      id: dto.id,
      invoiceNumber: dto.invoiceNumber,
      invoiceDate: dto.invoiceDate,
      salutation: dto.salutation ?? null,
      customerName: dto.customerName,
      customerAddress: dto.customerAddress,
      customerEmail: dto.customerEmail,
      companyName: dto.companyName,
      companyAddress: dto.companyAddress,
      companyCityCountry: dto.companyCityCountry,
      companyTaxId: dto.companyTaxId,
      companyCustomerName: dto.companyCustomerName,
      purchaseOrderNumber: dto.purchaseOrderNumber,
      tourDate: dto.tourDate,
      meetingPoint: dto.meetingPoint,
      pax: dto.pax,
      guide: dto.guide,
      civitatisId: dto.civitatisId,
      paymentMethod: dto.paymentMethod ? this.fromApiPaymentMethod(dto.paymentMethod) : null,
      language: dto.language as 'de' | 'en',
      status: dto.status.toLowerCase() as 'draft' | 'finalized',
      lineItems: dto.lineItems.map(li => ({
        id: li.id,
        tourId: li.tenantProductId,
        description: li.description,
        quantity: li.quantity,
        unitPriceNet: li.unitPriceNet,
        vatPercentage: li.vatPercentage as VatRate,
        lineTotalNet: li.lineTotalNet,
        lineTotalVat: li.lineTotalVat,
        lineTotalGross: li.lineTotalGross,
        sortOrder: li.sortOrder
      })),
      vatBreakdown: dto.vatBreakdown.map(v => ({
        vatPercentage: v.vatPercentage as VatRate,
        netTotal: v.netTotal,
        vatAmount: v.vatAmount,
        grossTotal: v.grossTotal
      })),
      totalNet: dto.totalNet,
      totalVat: dto.totalVat,
      totalGross: dto.totalGross,
      createdAt: '',
      updatedAt: ''
    };
  }

  private toApiPaymentMethod(pm: PaymentMethod): string {
    const map: Record<PaymentMethod, string> = {
      bank: 'Bank',
      paypal: 'Paypal',
      cash: 'Cash',
      civitatis: 'Civitatis',
      mypos: 'MyPos'
    };
    return map[pm];
  }

  private fromApiPaymentMethod(pm: string): PaymentMethod {
    const map: Record<string, PaymentMethod> = {
      Bank: 'bank',
      Paypal: 'paypal',
      Cash: 'cash',
      Civitatis: 'civitatis',
      MyPos: 'mypos'
    };
    return map[pm] ?? 'cash';
  }
}
