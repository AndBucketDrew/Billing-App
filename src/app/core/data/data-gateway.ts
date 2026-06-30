import { InjectionToken } from '@angular/core';
import type { Tour, Invoice, CompanySettings } from '../models/domain.models';

/**
 * Storage abstraction seam for the SaaS migration.
 *
 * Today this is backed by the Electron/JSON IPC layer ({@link ElectronDataGateway}).
 * The Supabase migration (see docs/supabase-saas-plan.md §3, §5) provides a second
 * implementation behind this same token, so feature services never change.
 *
 * Method shapes are kept IDENTICAL to the `electronAPI.{tour,invoice,settings}`
 * surface in electron/preload.ts. Local-OS concerns that are NOT storage
 * (e.g. settings.selectLogo, pdf/excel/sepa save, mail, Outlook) stay on
 * ElectronService and are intentionally excluded here.
 */

export interface TourGateway {
  getAll(): Promise<Tour[]>;
  create(tour: Omit<Tour, 'id' | 'createdAt' | 'updatedAt'>): Promise<Tour>;
  update(id: string, updates: Partial<Tour>): Promise<Tour | null>;
  delete(id: string): Promise<boolean>;
}

export interface InvoiceGateway {
  getAll(): Promise<Invoice[]>;
  getById(id: string): Promise<Invoice | null>;
  create(invoice: Omit<Invoice, 'id' | 'invoiceNumber' | 'createdAt' | 'updatedAt'>): Promise<Invoice>;
  update(id: string, updates: Partial<Invoice>): Promise<Invoice | null>;
  delete(id: string): Promise<boolean>;
  /** Atomically assigns an invoice number and sets status to 'finalized'. */
  finalize(id: string): Promise<Invoice | null>;
  /** Atomically creates a credit note AND marks the original 'storniert' in one write. */
  createCreditNote(originalId: string, payload: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>): Promise<Invoice>;
}

export interface SettingsGateway {
  get(): Promise<CompanySettings>;
  update(updates: Partial<CompanySettings>): Promise<CompanySettings>;
}

export interface DataGateway {
  readonly tour: TourGateway;
  readonly invoice: InvoiceGateway;
  readonly settings: SettingsGateway;
}

/** DI token resolved to the active storage backend (Electron today, Supabase later). */
export const DATA_GATEWAY = new InjectionToken<DataGateway>('DATA_GATEWAY');
