import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService } from './electron.service';
import { CalculationService } from './calculation.service';
import type { Invoice, CompanySettings, VatRate } from '../models/domain.models';
// @ts-ignore
import pdfMake from 'pdfmake/build/pdfmake';
// @ts-ignore
import pdfFonts from 'pdfmake/build/vfs_fonts';
import QRCode from 'qrcode';

if (pdfMake.vfs === undefined) {
  pdfMake.vfs = pdfFonts.pdfMake ? pdfFonts.pdfMake.vfs : pdfFonts;
}

@Injectable({
  providedIn: 'root'
})
export class PdfGeneratorService {

  constructor(
    private translate: TranslateService,
    private electron: ElectronService,
    private calculation: CalculationService
  ) { }

  /**
   * Generate and save PDF invoice
   */
  async generateInvoicePDF(
    invoice: Invoice,
    companySettings: CompanySettings
  ): Promise<void> {
    try {
      const docDefinition = await this.createInvoiceDocument(invoice, companySettings);
      const pdfDocGenerator = pdfMake.createPdf(docDefinition);

      await new Promise<void>((resolve, reject) => {
        try {
          pdfDocGenerator.getBase64(async (data: string) => {
            try {
              const filename = `${invoice.invoiceNumber}.pdf`;
              await this.electron.api.pdf.save(data, filename);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        } catch (err) {
          // getBase64 itself threw (e.g. bad image path, malformed doc)
          reject(err);
        }
      });
    } catch (error: any) {
      const message = error?.message ?? JSON.stringify(error);
      alert(`PDF Error: ${message}`);
      console.error('Error generating PDF:', error);
      throw error;
    }
  }

  /**
   * Create PDF document definition
   */
  private async createInvoiceDocument(
    invoice: Invoice,
    settings: CompanySettings
  ): Promise<any> {
    const currentLang = this.translate.currentLang;
    if (currentLang !== invoice.language) {
      this.translate.use(invoice.language);
    }

    const t = (key: string) => this.translate.instant(key);
    const lang = invoice.language;

    const content: any[] = [];

    // ── 1. HEADER: Logo left, company info right ──────────────────────────────
    let logoColumn: any = { width: 120, text: '' };
    if (settings.logoPath) {
      try {
        // pdfMake needs a data URL or base64 string, not a file path.
        // Try to load via fetch (works in Electron renderer).
        const resp = await fetch(settings.logoPath);
        if (resp.ok) {
          const blob = await resp.blob();
          const dataUrl = await new Promise<string>((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result as string);
            reader.onerror = rej;
            reader.readAsDataURL(blob);
          });
          logoColumn = { width: 120, image: dataUrl, fit: [120, 80] };
        }
      } catch {
        // Logo load failed — skip silently
      }
    }

    content.push({
      columns: [
        logoColumn,
        {
          width: '*',
          stack: [
            { text: settings.companyName, style: 'companyName', alignment: 'right' },
            { text: settings.companyAddress, style: 'companyAddress', alignment: 'right' },
            { text: [settings.city, settings.country].filter(Boolean).join(', '), style: 'companyAddress', alignment: 'right' },
            { text: `${t('SETTINGS.VAT_NUMBER')}: ${settings.vatNumber}`, style: 'companyAddress', alignment: 'right' }
          ]
        }
      ],
      margin: [0, 0, 0, 30]
    });

    // ── Invoice title and number ───────────────────────────────────────────────
    content.push({ text: t('INVOICE.TITLE'), style: 'header', margin: [0, 0, 0, 10] });
    content.push({
      columns: [{
        width: '*',
        stack: [
          { text: `${t('INVOICE.NUMBER')}: ${invoice.invoiceNumber}`, style: 'invoiceInfo' },
          { text: `${t('INVOICE.DATE')}: ${this.formatDate(invoice.invoiceDate, lang)}`, style: 'invoiceInfo' }
        ]
      }],
      margin: [0, 0, 0, 20]
    });

    // ── 2. CUSTOMER SECTION ───────────────────────────────────────────────────
    const customerStack: any[] = [];

    // Salutation + name
    if (invoice.salutation) {
      const salutationMap: Record<string, Record<string, string>> = {
        // German salutations (stored when form language was DE)
        frau: { de: 'Frau', en: 'Ms.' },
        herr: { de: 'Herr', en: 'Mr.' },
        divers: { de: 'Divers', en: 'Other' },
        // English salutations (stored when form language was EN)
        ms: { de: 'Frau', en: 'Ms.' },
        mrs: { de: 'Frau', en: 'Mrs.' },
        miss: { de: 'Frau', en: 'Miss' },
        mr: { de: 'Herr', en: 'Mr.' },
        diverse: { de: 'Divers', en: 'Other' },
      };
      const salutationLabel = salutationMap[invoice.salutation]?.[lang] ?? '';
      const nameText = salutationLabel ? `${salutationLabel} ${invoice.customerName}` : invoice.customerName;
      customerStack.push({ text: nameText, style: 'customerInfo' });
    } else {
      customerStack.push({ text: invoice.customerName, style: 'customerInfo' });
    }

    if (invoice.customerEmail) {
      customerStack.push({ text: invoice.customerEmail, style: 'customerInfo' });
    }

    // Company billing block
    const hasCompanyDetails =
      invoice.companyName ||
      invoice.companyAddress ||
      invoice.companyCityCountry ||
      invoice.companyTaxId ||
      invoice.companyCustomerName;

    if (hasCompanyDetails) {
      customerStack.push({ text: ' ', margin: [0, 4, 0, 0] });

      if (invoice.companyName) {
        customerStack.push({ text: invoice.companyName, style: 'customerInfo' });
      }
      if (invoice.companyAddress) {
        customerStack.push({ text: invoice.companyAddress, style: 'customerInfo' });
      }
      if (invoice.companyCityCountry) {
        customerStack.push({ text: invoice.companyCityCountry, style: 'customerInfo' });
      }
      if (invoice.companyTaxId) {
        customerStack.push({
          text: [
            // { text: (lang === 'de' ? 'St.-Nr.: ' : 'Tax ID: '), bold: true, fontSize: 10 },
            { text: invoice.companyTaxId, style: 'customerInfo' }
          ],
          margin: [0, 2, 0, 0]
        });
      }
      if (invoice.companyCustomerName) {
        const label = lang === 'de' ? 'z.Hd.: ' : 'Attn.: ';
        customerStack.push({
          text: [
            //{ text: label, bold: true, fontSize: 10 },
            { text: invoice.companyCustomerName, style: 'customerInfo' }
          ],
          margin: [0, 2, 0, 0]
        });
      }
    }

    // Purchase order number (shown prominently, outside the company sub-block)
    if (invoice.purchaseOrderNumber) {
      const poLabel = lang === 'de' ? 'Bestellnummer: ' : 'PO Number: ';
      customerStack.push({
        text: [
          // { text: poLabel, bold: true, fontSize: 10 },
          { text: invoice.purchaseOrderNumber, style: 'customerInfo' }
        ],
        margin: [0, 6, 0, 0]
      });
    }

    content.push({ stack: customerStack, margin: [0, 0, 0, 20] });

    // ── 3. INTRO TEXT ─────────────────────────────────────────────────────────
    const introText = lang === 'de'
      ? 'Vielen Dank für Ihren Auftrag. Wir stellen hiermit unsere erbrachten Leistungen in Rechnung.'
      : 'Thank you for your order. We hereby invoice our services rendered.';
    content.push({
      text: introText,
      italics: true,
      color: '#666666',
      fontSize: 10,
      margin: [0, 0, 0, 20]
    });

    // ── 4. LINE ITEMS TABLE ───────────────────────────────────────────────────
    const HEADER_BG = '#8a9a6a';
    const HEADER_FG = '#ffffff';
    const OUTER_BORDER_COLOR = '#888888';

    const outerOnlyLayout = {
      hLineWidth: (i: number, node: any) => {
        // top of table (i===0), bottom of header (i===1), bottom of table (i===last)
        if (i === 0 || i === 1 || i === node.table.body.length) return 1;
        return 0;
      },
      vLineWidth: (i: number, node: any) => {
        if (i === 0 || i === node.table.widths.length) return 1;
        return 0;
      },
      hLineColor: () => OUTER_BORDER_COLOR,
      vLineColor: () => OUTER_BORDER_COLOR,
      fillColor: (rowIndex: number) => rowIndex === 0 ? HEADER_BG : null,
      paddingTop: (i: number) => i === 0 ? 6 : 4,
      paddingBottom: (i: number) => i === 0 ? 6 : 4,
      paddingLeft: () => 6,
      paddingRight: () => 6,
    };

    const tableBody: any[] = [
      [
        { text: t('INVOICE.DESCRIPTION'), style: 'tableHeader', color: HEADER_FG },
        { text: t('INVOICE.QUANTITY'), style: 'tableHeader', color: HEADER_FG, alignment: 'right' },
        { text: t('TOUR.UNIT_PRICE'), style: 'tableHeader', color: HEADER_FG, alignment: 'right' },
        { text: t('INVOICE.VAT'), style: 'tableHeader', color: HEADER_FG, alignment: 'right' },
        { text: t('TOUR.TOTAL'), style: 'tableHeader', color: HEADER_FG, alignment: 'right' }
      ]
    ];

    // Build tour details bullet list (shared across all items since invoice has one set)
    const tourDetailLines: any[] = [];
    if (invoice.tourDate) {
      tourDetailLines.push({
        text: [{ text: '· Am: ', bold: true }, { text: this.formatDateTime(invoice.tourDate, lang) }],
        fontSize: 9, color: '#555555', margin: [0, 1, 0, 0]
      });
    }
    if (invoice.meetingPoint) {
      tourDetailLines.push({
        text: [{ text: `· ${t('INVOICE.MEETING_POINT')}: `, bold: true }, { text: invoice.meetingPoint }],
        fontSize: 9, color: '#555555', margin: [0, 1, 0, 0]
      });
    }
    if (invoice.pax != null) {
      tourDetailLines.push({
        text: [{ text: '· Pax: ', bold: true }, { text: invoice.pax.toString() }],
        fontSize: 9, color: '#555555', margin: [0, 1, 0, 0]
      });
    }
    if (invoice.guide) {
      tourDetailLines.push({
        text: [{ text: '· Guide: ', bold: true }, { text: invoice.guide }],
        fontSize: 9, color: '#555555', margin: [0, 1, 0, 0]
      });
    }
    if (invoice.civitatisId) {
      tourDetailLines.push({
        text: [{ text: '· Civitatis ID: ', bold: true }, { text: invoice.civitatisId }],
        fontSize: 9, color: '#555555', margin: [0, 1, 0, 0]
      });
    }

    // Line item rows — numbered, no tour details here
    invoice.lineItems.forEach((item, index) => {
      tableBody.push([
        { text: `${index + 1}. ${item.description}`, style: 'tableCell' },
        { text: item.quantity.toString(), style: 'tableCell', alignment: 'right' },
        { text: this.formatCurrency(item.unitPriceNet, lang), style: 'tableCell', alignment: 'right' },
        { text: this.formatVat(item.vatPercentage, lang), style: 'tableCell', alignment: 'right' },
        { text: this.formatCurrency(item.lineTotalGross, lang), style: 'tableCell', alignment: 'right' }
      ]);
    });

    // Tour details as a single row spanning all columns, after all items
    if (tourDetailLines.length > 0) {
      tableBody.push([
        { stack: tourDetailLines, colSpan: 5, margin: [0, 4, 0, 2] },
        {}, {}, {}, {}
      ]);
    }

    content.push({
      table: {
        headerRows: 1,
        widths: ['*', 'auto', 'auto', 'auto', 'auto'],
        body: tableBody
      },
      layout: outerOnlyLayout,
      margin: [0, 0, 0, 20]
    });

    // ── 5. VAT SUMMARY (with optional EPC QR code on the left) ──────────────
    const summaryTable: any[] = [];

    invoice.vatBreakdown.forEach(vat => {
      if (vat.vatPercentage === 0) {
        summaryTable.push([
          { text: lang === 'de' ? 'Umkehr.' : 'Rev. Charge', style: 'summaryLabel' },
          { text: this.formatCurrency(vat.netTotal, lang), style: 'summaryValue', alignment: 'right' }
        ]);
      } else {
        const netLabel = lang === 'de' ? `Netto ${vat.vatPercentage}%` : `Net ${vat.vatPercentage}%`;
        const vatLabel = lang === 'de' ? `USt. ${vat.vatPercentage}%` : `VAT ${vat.vatPercentage}%`;
        summaryTable.push([
          { text: netLabel, style: 'summaryLabel' },
          { text: this.formatCurrency(vat.netTotal, lang), style: 'summaryValue', alignment: 'right' }
        ]);
        summaryTable.push([
          { text: vatLabel, style: 'summaryLabel' },
          { text: this.formatCurrency(vat.vatAmount, lang), style: 'summaryValue', alignment: 'right' }
        ]);
      }
    });

    summaryTable.push([
      { text: '', colSpan: 2, border: [false, true, false, false], margin: [0, 5, 0, 5] },
      {}
    ]);
    summaryTable.push([
      { text: t('INVOICE.TOTAL_GROSS'), style: 'grandTotal' },
      { text: this.formatCurrency(invoice.totalGross, lang), style: 'grandTotal', alignment: 'right' }
    ]);

    const summaryTableBlock = {
      table: { widths: ['*', 'auto'], body: summaryTable },
      layout: 'noBorders'
    };

    // Generate QR code when payment method is bank and bank details are available
    let qrDataUrl: string | null = null;
    if (invoice.paymentMethod === 'bank' && settings.iban && settings.bic && settings.accountHolder) {
      qrDataUrl = await this.generateEpcQrCode(
        settings.bic,
        settings.accountHolder,
        settings.iban,
        invoice.totalGross,
        invoice.invoiceNumber
      );
    }

    if (qrDataUrl) {
      const qrCaption = lang === 'de'
        ? 'QR-Code scannen\nzum Bezahlen'
        : 'Scan QR code\nto pay';

      content.push({
        columns: [
          {
            width: 'auto',
            stack: [
              { image: qrDataUrl, fit: [90, 90] },
              { text: qrCaption, fontSize: 7, color: '#666666', alignment: 'center', margin: [0, 2, 0, 0] }
            ]
          },
          { width: '*', text: '' },
          { width: 'auto', ...summaryTableBlock }
        ],
        margin: [0, 0, 0, 20]
      });
    } else {
      content.push({ ...summaryTableBlock, margin: [300, 0, 0, 20] } as any);
    }

    // ── 5b. PAYMENT METHOD ────────────────────────────────────────────────────
    if (invoice.paymentMethod) {
      const pmLabels: Record<string, string> = {
        bank: lang === 'de' ? 'Bank Überweisung' : 'Bank Transfer',
        paypal: 'PayPal',
        cash: lang === 'de' ? 'Bar' : 'Cash',
        civitatis: 'Civitatis',
        mypos: lang === 'de' ? 'MyPos - Kreditkarte' : 'MyPos - Credit Card'
      };
      const pmLabel = pmLabels[invoice.paymentMethod] ?? invoice.paymentMethod;
      const pmText = lang === 'de'
        ? `Zahlungsart: ${pmLabel}`
        : `Payment Method: ${pmLabel}`;

      content.push({ text: pmText, fontSize: 10, margin: [0, 0, 0, 20], alignment: 'left' });
    }

    // ── 6. CUSTOM FOOTER TEXT ─────────────────────────────────────────────────
    if (settings.invoiceFooterText) {
      content.push({
        text: settings.invoiceFooterText,
        alignment: 'left',
        fontSize: 10,
        margin: [0, 0, 0, 20]
      });
    }

    // ── 7. COMPANY DETAILS FOOTER (3 plain text columns, no borders) ────────────
    const footerTextStyle = { fontSize: 8, color: '#666666' };
    const footerLabelStyle = { fontSize: 8, color: '#666666', bold: true };

    const footerLine = (label: string, value: string) => ({
      text: [
        { text: `${label}: `, ...footerLabelStyle },
        { text: value, ...footerTextStyle }
      ]
    });

    const col1: any[] = [];
    if (settings.companyName) col1.push({ text: settings.companyName, ...footerTextStyle });
    if (settings.companyAddress) col1.push({ text: settings.companyAddress, ...footerTextStyle });
    const cityCountry = [settings.city, settings.country].filter(Boolean).join(', ');
    if (cityCountry) col1.push({ text: cityCountry, ...footerTextStyle });

    const col2: any[] = [];
    if (settings.bankName) col2.push(footerLine('Bankverbindung', settings.bankName));
    if (settings.accountHolder) col2.push(footerLine('Kontoinhaber', settings.accountHolder));
    if (settings.iban) col2.push(footerLine('IBAN', settings.iban));
    if (settings.bic) col2.push(footerLine('BIC', settings.bic));

    const col3: any[] = [];
    if (settings.legalForm) col3.push(footerLine('Firma & Rechtsform', settings.legalForm));
    if (settings.headquarters) col3.push(footerLine('Firmensitz', settings.headquarters));
    if (settings.courtRegistry) col3.push(footerLine('FB-Gericht', settings.courtRegistry));
    if (settings.registrationNumber) col3.push(footerLine('FB-Nummer', settings.registrationNumber));

    content.push({
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#cccccc' }],
      margin: [0, 20, 0, 8]
    });

    content.push({
      columns: [
        { width: '*', stack: col1.length ? col1 : [{ text: '', fontSize: 8 }] },
        { width: '*', stack: col2.length ? col2 : [{ text: '', fontSize: 8 }] },
        { width: '*', stack: col3.length ? col3 : [{ text: '', fontSize: 8 }] }
      ],
      columnGap: 10
    });

    // Restore original language
    if (currentLang !== invoice.language) {
      this.translate.use(currentLang);
    }

    return {
      content,
      styles: {
        companyName: { fontSize: 16, bold: true },
        companyAddress: { fontSize: 10, color: '#666666' },
        header: { fontSize: 24, bold: true, color: '#333333' },
        invoiceInfo: { fontSize: 11, margin: [0, 2, 0, 2] },
        sectionHeader: { fontSize: 12, bold: true, color: '#333333' },
        customerInfo: { fontSize: 11 },
        tableHeader: { fontSize: 10, bold: true },
        tableCell: { fontSize: 10 },
        summaryLabel: { fontSize: 11, margin: [0, 2, 0, 2] },
        summaryValue: { fontSize: 11, margin: [0, 2, 0, 2] },
        grandTotal: { fontSize: 13, bold: true, margin: [0, 5, 0, 0] }
      },
      defaultStyle: { font: 'Roboto' },
      pageMargins: [40, 40, 40, 40]
    };
  }

  // ── EPC QR code (GiroCode / SEPA Credit Transfer) ──────────────────────────

  /**
   * Generates an EPC QR code (GiroCode) as a base64 PNG data URL.
   * The format is the European Payments Council standard that all SEPA-compatible
   * mobile banking apps can scan to pre-fill a bank transfer.
   */
  private async generateEpcQrCode(
    bic: string,
    accountHolder: string,
    iban: string,
    amount: number,
    reference: string
  ): Promise<string | null> {
    try {
      // EPC QR code v002, encoding UTF-8, SEPA Credit Transfer
      const amountFormatted = `EUR${amount.toFixed(2)}`;
      const epcString = [
        'BCD',           // Service Tag
        '002',           // Version
        '1',             // Character set: UTF-8
        'SCT',           // Identification: SEPA Credit Transfer
        bic.trim(),      // BIC
        accountHolder.trim().substring(0, 70),  // Beneficiary name (max 70 chars)
        iban.replace(/\s/g, ''),  // IBAN (no spaces)
        amountFormatted, // Amount
        '',              // Purpose (optional)
        '',              // Creditor reference (optional)
        reference.trim().substring(0, 140),  // Remittance info (invoice number)
      ].join('\n');

      return await QRCode.toDataURL(epcString, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 200
      });
    } catch {
      return null;
    }
  }

  // ── Formatting helpers ──────────────────────────────────────────────────────

  private formatCurrency(value: number, language: 'de' | 'en'): string {
    const locale = language === 'de' ? 'de-DE' : 'en-US';
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value);
  }

  private formatVat(vat: number, language: 'de' | 'en'): string {
    if (vat === 0) {
      return language === 'de' ? 'Umkehr.' : 'Rev. Charge';
    }
    return `${vat}%`;
  }

  private formatDate(dateString: string, language: 'de' | 'en'): string {
    const date = new Date(dateString);
    return date.toLocaleDateString(language === 'de' ? 'de-DE' : 'en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  }

  private formatDateTime(dateString: string, language: 'de' | 'en'): string {
    const date = new Date(dateString);
    return date.toLocaleString(language === 'de' ? 'de-DE' : 'en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }

  private getLocale(language: 'de' | 'en'): string {
    return language === 'de' ? 'de-DE' : 'en-US';
  }
}