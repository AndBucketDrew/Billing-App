import type {
  Tour,
  Invoice,
  InvoiceLineItem,
  CompanySettings,
  VatRate,
  PaymentMethod,
} from '../models/domain.models';
import type { CalculationService } from '../services/calculation.service';

/**
 * Pure mappers between Postgres rows (snake_case) and the camelCase domain
 * shapes. Kept separate from the gateway so they're trivially unit-testable.
 *
 * numeric columns can arrive from PostgREST as strings (precision preservation),
 * so every money/quantity field is coerced through num().
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const vat = (v: unknown): VatRate => Number(v) as VatRate;

// ── Tours ─────────────────────────────────────────────────────────────────────

export function tourFromRow(row: any): Tour {
  return {
    id: row.id,
    name: row.name ?? '',
    description: row.description ?? '',
    meetingPoint: row.meeting_point ?? '',
    basePriceNet: num(row.base_price_net),
    vatPercentage: row.vat_percentage == null ? undefined : vat(row.vat_percentage),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Maps the provided (possibly partial) tour fields to a row. Omits absent keys. */
export function tourToRow(tour: Partial<Tour>): Record<string, any> {
  const row: Record<string, any> = {};
  if ('name' in tour) row['name'] = tour.name;
  if ('description' in tour) row['description'] = tour.description;
  if ('meetingPoint' in tour) row['meeting_point'] = tour.meetingPoint;
  if ('basePriceNet' in tour) row['base_price_net'] = tour.basePriceNet;
  if ('vatPercentage' in tour) row['vat_percentage'] = tour.vatPercentage ?? null;
  return row;
}

// ── Line items ─────────────────────────────────────────────────────────────────

export function lineItemFromRow(row: any): InvoiceLineItem {
  return {
    id: row.id,
    tourId: row.tour_id ?? undefined,
    description: row.description ?? '',
    quantity: num(row.quantity),
    unitPriceNet: num(row.unit_price_net),
    vatPercentage: vat(row.vat_percentage),
    lineTotalNet: num(row.line_total_net),
    lineTotalVat: num(row.line_total_vat),
    lineTotalGross: num(row.line_total_gross),
    sortOrder: Number(row.sort_order ?? 0),
  };
}

export function lineItemToRow(item: InvoiceLineItem): Record<string, any> {
  return {
    id: item.id,
    tour_id: item.tourId ?? null,
    description: item.description,
    quantity: item.quantity,
    unit_price_net: item.unitPriceNet,
    vat_percentage: item.vatPercentage,
    line_total_net: item.lineTotalNet,
    line_total_vat: item.lineTotalVat,
    line_total_gross: item.lineTotalGross,
    sort_order: item.sortOrder,
  };
}

// ── Invoices ───────────────────────────────────────────────────────────────────

/** camelCase domain key -> snake_case column, for scalar invoice fields. */
const INVOICE_FIELDS: Array<[keyof Invoice, string]> = [
  ['invoiceNumber', 'invoice_number'],
  ['invoiceDate', 'invoice_date'],
  ['salutation', 'salutation'],
  ['customerName', 'customer_name'],
  ['customerAddress', 'customer_address'],
  ['customerEmail', 'customer_email'],
  ['companyName', 'company_name'],
  ['companyAddress', 'company_address'],
  ['companyCityCountry', 'company_city_country'],
  ['companyTaxId', 'company_tax_id'],
  ['companyCustomerName', 'company_customer_name'],
  ['purchaseOrderNumber', 'purchase_order_number'],
  ['tourDate', 'tour_date'],
  ['meetingPoint', 'meeting_point'],
  ['pax', 'pax'],
  ['guide', 'guide'],
  ['civitatisId', 'civitatis_id'],
  ['paymentMethod', 'payment_method'],
  ['type', 'type'],
  ['creditNoteForInvoiceNumber', 'credit_note_for_invoice_number'],
  ['isPaid', 'is_paid'],
  ['language', 'language'],
  ['status', 'status'],
  ['totalNet', 'total_net'],
  ['totalVat', 'total_vat'],
  ['totalGross', 'total_gross'],
];

/**
 * Row (with nested `line_items`) -> domain Invoice. vatBreakdown is DERIVED
 * here from the line items (never stored); the stored totals are returned as-is.
 */
export function invoiceFromRow(row: any, calc: CalculationService): Invoice {
  const lineItems: InvoiceLineItem[] = (row.line_items ?? [])
    .map(lineItemFromRow)
    .sort((a: InvoiceLineItem, b: InvoiceLineItem) => a.sortOrder - b.sortOrder);

  const { vatBreakdown } = calc.calculateInvoiceTotals(lineItems);

  return {
    id: row.id,
    invoiceNumber: row.invoice_number ?? null,
    invoiceDate: row.invoice_date,
    salutation: row.salutation ?? null,
    customerName: row.customer_name ?? '',
    customerAddress: row.customer_address ?? '',
    customerEmail: row.customer_email ?? null,
    companyName: row.company_name ?? null,
    companyAddress: row.company_address ?? null,
    companyCityCountry: row.company_city_country ?? null,
    companyTaxId: row.company_tax_id ?? null,
    companyCustomerName: row.company_customer_name ?? null,
    purchaseOrderNumber: row.purchase_order_number ?? null,
    tourDate: row.tour_date ?? null,
    meetingPoint: row.meeting_point ?? null,
    pax: row.pax == null ? null : Number(row.pax),
    guide: row.guide ?? null,
    civitatisId: row.civitatis_id ?? null,
    paymentMethod: (row.payment_method ?? null) as PaymentMethod | null,
    type: row.type ?? null,
    creditNoteForInvoiceNumber: row.credit_note_for_invoice_number ?? null,
    isPaid: row.is_paid ?? null,
    language: row.language,
    status: row.status,
    lineItems,
    vatBreakdown,
    totalNet: num(row.total_net),
    totalVat: num(row.total_vat),
    totalGross: num(row.total_gross),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps the provided (possibly partial) invoice fields to a row. Omits absent
 * keys, and never emits lineItems/vatBreakdown (handled separately / derived).
 */
export function invoiceToRow(inv: Partial<Invoice>): Record<string, any> {
  const row: Record<string, any> = {};
  for (const [camel, snake] of INVOICE_FIELDS) {
    if (camel in inv) row[snake] = (inv as any)[camel];
  }
  return row;
}

// ── Import rows (preserve id + timestamps; for import_org_data only) ────────────

/** A tour row carrying its original id/timestamps, for the one-time importer. */
export function tourToImportRow(t: Tour): Record<string, any> {
  return {
    ...tourToRow(t),
    id: t.id,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

/**
 * An invoice row carrying its original id/number/status/timestamps plus nested
 * `line_items`, for the one-time importer (these are already-numbered legal
 * records, not new drafts).
 */
export function invoiceToImportRow(inv: Invoice): Record<string, any> {
  return {
    ...invoiceToRow(inv),
    id: inv.id,
    created_at: inv.createdAt,
    updated_at: inv.updatedAt,
    line_items: inv.lineItems.map(lineItemToRow),
  };
}

// ── Company settings ─────────────────────────────────────────────────────────

const SETTINGS_FIELDS: Array<[keyof CompanySettings, string]> = [
  ['language', 'language'],
  ['invoiceCounter', 'invoice_counter'],
  ['invoiceCounterYear', 'invoice_counter_year'],
  ['companyName', 'company_name'],
  ['companyAddress', 'company_address'],
  ['cityCountry', 'city_country'],
  ['vatNumber', 'vat_number'],
  ['logoPath', 'logo_path'],
  ['defaultVatPercentage', 'default_vat_percentage'],
  ['bankName', 'bank_name'],
  ['accountHolder', 'account_holder'],
  ['iban', 'iban'],
  ['bic', 'bic'],
  ['legalForm', 'legal_form'],
  ['headquarters', 'headquarters'],
  ['courtRegistry', 'court_registry'],
  ['registrationNumber', 'registration_number'],
  ['brandColor', 'brand_color'],
  ['invoiceFooterText', 'invoice_footer_text'],
  ['emailSubjectDe', 'email_subject_de'],
  ['emailSubjectEn', 'email_subject_en'],
  ['emailBodyDe', 'email_body_de'],
  ['emailBodyEn', 'email_body_en'],
];

export function settingsFromRow(row: any): CompanySettings {
  return {
    language: row.language,
    invoiceCounter: Number(row.invoice_counter ?? 1),
    invoiceCounterYear: row.invoice_counter_year == null ? undefined : Number(row.invoice_counter_year),
    companyName: row.company_name ?? '',
    companyAddress: row.company_address ?? '',
    cityCountry: row.city_country ?? '',
    vatNumber: row.vat_number ?? '',
    logoPath: row.logo_path ?? '',
    defaultVatPercentage: vat(row.default_vat_percentage),
    bankName: row.bank_name ?? '',
    accountHolder: row.account_holder ?? '',
    iban: row.iban ?? '',
    bic: row.bic ?? '',
    legalForm: row.legal_form ?? '',
    headquarters: row.headquarters ?? '',
    courtRegistry: row.court_registry ?? '',
    registrationNumber: row.registration_number ?? '',
    brandColor: row.brand_color ?? undefined,
    invoiceFooterText: row.invoice_footer_text ?? '',
    emailSubjectDe: row.email_subject_de ?? undefined,
    emailSubjectEn: row.email_subject_en ?? undefined,
    emailBodyDe: row.email_body_de ?? undefined,
    emailBodyEn: row.email_body_en ?? undefined,
  };
}

export function settingsToRow(s: Partial<CompanySettings>): Record<string, any> {
  const row: Record<string, any> = {};
  for (const [camel, snake] of SETTINGS_FIELDS) {
    if (camel in s) row[snake] = (s as any)[camel];
  }
  return row;
}

/** Fallback settings used before an authenticated session exists. */
export const DEFAULT_SETTINGS: CompanySettings = {
  language: 'de',
  invoiceCounter: 1,
  companyName: '',
  companyAddress: '',
  cityCountry: '',
  vatNumber: '',
  logoPath: '',
  defaultVatPercentage: 13,
  bankName: '',
  accountHolder: '',
  iban: '',
  bic: '',
  legalForm: '',
  headquarters: '',
  courtRegistry: '',
  registrationNumber: '',
  invoiceFooterText: '',
};
