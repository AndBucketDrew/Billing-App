import { Injectable } from '@angular/core';
import { SupabaseService } from '../services/supabase.service';
import { CalculationService } from '../services/calculation.service';
import type { DataGateway, TourGateway, InvoiceGateway, SettingsGateway } from './data-gateway';
import type { Tour, Invoice, CompanySettings } from '../models/domain.models';
import * as M from './supabase-mappers';

/**
 * Supabase-backed {@link DataGateway} (docs/supabase-saas-plan.md §5).
 *
 * Tables are accessed directly (RLS scopes every query to the caller's org);
 * the atomic operations go through the SECURITY DEFINER RPCs (create_invoice,
 * finalize_invoice, create_credit_note).
 *
 * No-session safety: reads return empty/default values when there is no auth
 * session yet (e.g. while the /login page is up and SettingsService boots), so
 * swapping this in for ElectronDataGateway never throws before sign-in. Writes
 * still require a session and will surface an RLS error if attempted without one.
 */
@Injectable({ providedIn: 'root' })
export class SupabaseDataGateway implements DataGateway {
  private orgIdCache: string | null = null;

  constructor(
    private supabase: SupabaseService,
    private calc: CalculationService,
  ) {
    // Drop the cached org id whenever the session changes (sign out / switch user).
    this.supabase.session$.subscribe(() => (this.orgIdCache = null));
  }

  private get db() {
    return this.supabase.client;
  }

  private get hasSession(): boolean {
    return !!this.supabase.session;
  }

  /** The current user's org id (cached for the session). */
  private async orgId(): Promise<string> {
    if (this.orgIdCache) return this.orgIdCache;
    const { data, error } = await this.db
      .from('organization_members')
      .select('org_id')
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('No organization for current user');
    this.orgIdCache = data.org_id as string;
    return this.orgIdCache;
  }

  readonly tour: TourGateway = {
    getAll: async (): Promise<Tour[]> => {
      if (!this.hasSession) return [];
      const { data, error } = await this.db.from('tours').select('*').order('created_at');
      if (error) throw error;
      return (data ?? []).map(M.tourFromRow);
    },

    create: async (tour): Promise<Tour> => {
      const row = { ...M.tourToRow(tour), organization_id: await this.orgId() };
      const { data, error } = await this.db.from('tours').insert(row).select().single();
      if (error) throw error;
      return M.tourFromRow(data);
    },

    update: async (id, updates): Promise<Tour | null> => {
      // updated_at is stamped server-side by the touch trigger (migration 700).
      const { data, error } = await this.db
        .from('tours')
        .update(M.tourToRow(updates))
        .eq('id', id)
        .select()
        .maybeSingle();
      if (error) throw error;
      return data ? M.tourFromRow(data) : null;
    },

    delete: async (id): Promise<boolean> => {
      const { error } = await this.db.from('tours').delete().eq('id', id);
      if (error) throw error;
      return true;
    },
  };

  readonly invoice: InvoiceGateway = {
    getAll: async (): Promise<Invoice[]> => {
      if (!this.hasSession) return [];
      const { data, error } = await this.db
        .from('invoices')
        .select('*, line_items:invoice_line_items(*)')
        .order('created_at');
      if (error) throw error;
      return (data ?? []).map((r) => M.invoiceFromRow(r, this.calc));
    },

    getById: async (id): Promise<Invoice | null> => {
      if (!this.hasSession) return null;
      const { data, error } = await this.db
        .from('invoices')
        .select('*, line_items:invoice_line_items(*)')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? M.invoiceFromRow(data, this.calc) : null;
    },

    create: async (invoice): Promise<Invoice> => {
      const { data, error } = await this.db.rpc('create_invoice', {
        p_invoice: M.invoiceToRow(invoice),
        p_line_items: invoice.lineItems.map(M.lineItemToRow),
      });
      if (error) throw error;
      return M.invoiceFromRow(data, this.calc);
    },

    update: async (id, updates): Promise<Invoice | null> => {
      // Header patch + (optional) whole line-item replacement in one transaction
      // via the update_invoice RPC. Line items replace the whole set (drafts only
      // — the immutability trigger blocks this on finalized invoices); pass null
      // to leave them untouched. updated_at is stamped server-side.
      const { data, error } = await this.db.rpc('update_invoice', {
        p_id: id,
        p_updates: M.invoiceToRow(updates),
        p_line_items: updates.lineItems ? updates.lineItems.map(M.lineItemToRow) : null,
      });
      if (error) throw error;
      return data ? M.invoiceFromRow(data, this.calc) : null;
    },

    delete: async (id): Promise<boolean> => {
      const { error } = await this.db.from('invoices').delete().eq('id', id);
      if (error) throw error;
      return true;
    },

    finalize: async (id): Promise<Invoice | null> => {
      const { data, error } = await this.db.rpc('finalize_invoice', { p_invoice_id: id });
      if (error) throw error;
      return data ? M.invoiceFromRow(data, this.calc) : null;
    },

    createCreditNote: async (originalId, payload): Promise<Invoice> => {
      const { data, error } = await this.db.rpc('create_credit_note', {
        p_original_id: originalId,
        p_invoice: M.invoiceToRow(payload),
        p_line_items: payload.lineItems.map(M.lineItemToRow),
      });
      if (error) throw error;
      return M.invoiceFromRow(data, this.calc);
    },
  };

  readonly settings: SettingsGateway = {
    get: async (): Promise<CompanySettings> => {
      if (!this.hasSession) return M.DEFAULT_SETTINGS;
      const { data, error } = await this.db.from('company_settings').select('*').maybeSingle();
      if (error) throw error;
      return data ? M.settingsFromRow(data) : M.DEFAULT_SETTINGS;
    },

    update: async (updates): Promise<CompanySettings> => {
      // RLS already scopes this to the caller's single settings row, so no
      // org filter (and its extra round-trip) is needed; updated_at is stamped
      // server-side by the touch trigger (migration 700).
      const { data, error } = await this.db
        .from('company_settings')
        .update(M.settingsToRow(updates))
        .select()
        .maybeSingle();
      if (error) throw error;
      // A null row means the org has no company_settings row at all — the signup
      // trigger normally creates it, so this only happens if that failed or the row
      // was deleted. Surface it clearly instead of letting `.single()` throw an
      // opaque PGRST116, which read paths silently mask by falling back to defaults.
      if (!data) {
        throw new Error(
          'No settings row for your organization — it may not have been provisioned. Please contact support.',
        );
      }
      return M.settingsFromRow(data);
    },
  };
}
