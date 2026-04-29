// Backend API response DTOs (matches C# DTOs with camelCase JSON serialization)

export interface UserAuthDto {
  id: string;
  userName: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  access_token: string;
  isAuthenticated: boolean;
  profilePhoto: string;
  claims: AppClaimDto[];
}

export interface AppClaimDto {
  claimType: string;
  claimValue: string;
}

export interface TenantProductDto {
  id: string;
  name: string;
  description?: string;
  meetingPoint?: string;
  basePriceNet: number;
  defaultVatPercentage: number;
  tenantId: string;
}

export interface BillingInvoiceDto {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  salutation?: string;
  customerName: string;
  customerAddress: string;
  customerEmail?: string;
  companyName?: string;
  companyAddress?: string;
  companyCityCountry?: string;
  companyTaxId?: string;
  companyCustomerName?: string;
  purchaseOrderNumber?: string;
  tourDate?: string;
  meetingPoint?: string;
  pax?: number;
  guide?: string;
  civitatisId?: string;
  paymentMethod?: string; // 'Bank' | 'Paypal' | 'Cash' | 'Civitatis' | 'MyPos'
  language: string;
  status: string;        // 'Draft' | 'Finalized'
  totalNet: number;
  totalVat: number;
  totalGross: number;
  accountId: string;
  lineItems: BillingInvoiceLineItemDto[];
  vatBreakdown: BillingInvoiceVatBreakdownDto[];
}

export interface BillingInvoiceLineItemDto {
  id: string;
  invoiceId: string;
  tenantProductId?: string;
  description: string;
  quantity: number;
  unitPriceNet: number;
  vatPercentage: number;
  lineTotalNet: number;
  lineTotalVat: number;
  lineTotalGross: number;
  sortOrder: number;
}

export interface BillingInvoiceVatBreakdownDto {
  id: string;
  invoiceId: string;
  vatPercentage: number;
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
}

export interface BillingSettingsDto {
  tenantId: string;
  companyName: string;
  companyAddress?: string;
  cityCountry?: string;
  vatNumber?: string;
  logoPath?: string;
  defaultVatPercentage: number;
  bankName?: string;
  accountHolder?: string;
  iban?: string;
  bic?: string;
  registrationNumber?: string;
}

export interface AddBillingInvoiceRequest {
  invoiceDate: string;
  salutation?: string;
  customerName: string;
  customerAddress: string;
  customerEmail?: string;
  companyName?: string;
  companyAddress?: string;
  companyCityCountry?: string;
  companyTaxId?: string;
  companyCustomerName?: string;
  purchaseOrderNumber?: string;
  tourDate?: string;
  meetingPoint?: string;
  pax?: number;
  guide?: string;
  civitatisId?: string;
  paymentMethod?: string;
  language: string;
  lineItems: BillingInvoiceLineItemInput[];
}

export interface BillingInvoiceLineItemInput {
  tenantProductId?: string;
  description: string;
  quantity: number;
  unitPriceNet: number;
  vatPercentage: number;
  sortOrder: number;
}
