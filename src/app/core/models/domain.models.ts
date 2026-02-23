// Core domain models

export interface Tour {
  id: string;
  name: string;
  description: string;
  meetingPoint: string;
  basePriceNet: number;
  vatPercentage?: VatRate; // Optional now, set per invoice
  createdAt: string;
  updatedAt: string;
}

export type VatRate = 0 | 10 | 13 | 20;

export interface InvoiceLineItem {
  id: string;
  tourId?: string; // Optional: can be custom line item
  description: string;
  quantity: number;
  unitPriceNet: number;
  vatPercentage: VatRate;
  lineTotalNet: number;
  lineTotalVat: number;
  lineTotalGross: number;
  sortOrder: number;
}

export interface VatBreakdownItem {
  vatPercentage: VatRate;
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;       // ISO date string
  customerName: string;
  customerAddress: string;   // kept for backward compatibility
  customerEmail?: string | null;

  // Company billing details (all optional)
  companyName?: string | null;
  companyAddress?: string | null;
  companyCityCountry?: string | null;

  // Tour details
  tourDate?: string | null;  // datetime-local ISO string (Am)
  pax?: number | null;       // number of persons
  guide?: string | null;     // tour guide name

  language: 'de' | 'en';
  status: 'draft' | 'finalized';
  lineItems: InvoiceLineItem[];
  vatBreakdown: VatBreakdownItem[];
  totalNet: number;
  totalVat: number;
  totalGross: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompanySettings {
  language: 'de' | 'en';
  companyName: string;
  companyAddress: string;
  cityCountry: string;
  vatNumber: string;
  logoPath?: string;
  defaultVatPercentage: VatRate;
  // Bank details
  bankName: string;
  accountHolder: string;
  iban: string;
  bic: string;
  // Legal details
  legalForm: string;
  headquarters: string;
  courtRegistry: string;
  registrationNumber: string;
  // Invoice footer
  invoiceFooterText: string;
}

export interface ToursData {
  tours: Tour[];
}

export interface InvoicesData {
  invoices: Invoice[];
}

// Helper type for VAT display
export interface VatLabelConfig {
  rate: VatRate;
  labelKey: string; // Translation key or 'reversed' indicator
}

export const VAT_RATES: VatLabelConfig[] = [
  { rate: 0, labelKey: 'reversed' },
  { rate: 10, labelKey: 'standard' },
  { rate: 13, labelKey: 'standard' },
  { rate: 20, labelKey: 'standard' }
];