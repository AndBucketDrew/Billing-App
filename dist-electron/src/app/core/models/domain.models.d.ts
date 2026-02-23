export interface Tour {
    id: string;
    name: string;
    description: string;
    meetingPoint: string;
    basePriceNet: number;
    vatPercentage?: VatRate;
    createdAt: string;
    updatedAt: string;
}
export type VatRate = 0 | 10 | 13 | 20;
export interface InvoiceLineItem {
    id: string;
    tourId?: string;
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
    bankName: string;
    accountHolder: string;
    iban: string;
    bic: string;
    legalForm: string;
    headquarters: string;
    courtRegistry: string;
    registrationNumber: string;
    invoiceFooterText: string;
}
export interface ToursData {
    tours: Tour[];
}
export interface InvoicesData {
    invoices: Invoice[];
}
export interface VatLabelConfig {
    rate: VatRate;
    labelKey: string;
}
export declare const VAT_RATES: VatLabelConfig[];
//# sourceMappingURL=domain.models.d.ts.map