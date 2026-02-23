import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService } from './electron.service';
import { CalculationService } from './calculation.service';
import type { Invoice, CompanySettings, VatRate } from '../models/domain.models';
// @ts-ignore
import pdfMake from 'pdfmake/build/pdfmake';
// @ts-ignore
import pdfFonts from 'pdfmake/build/vfs_fonts';

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
  ) {}

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
      // Show a visible alert so you can debug without DevTools
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
        // Logo load failed — skip it silently, don't break the whole PDF
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
            { text: settings.cityCountry, style: 'companyAddress', alignment: 'right' },
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
    const customerStack: any[] = [
      { text: invoice.customerName, style: 'customerInfo' }
    ];
    if (invoice.customerEmail) {
      customerStack.push({ text: invoice.customerEmail, style: 'customerInfo' });
    }

    const hasCompanyDetails = invoice.companyName || invoice.companyAddress || invoice.companyCityCountry;
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

    // ── Line items table + tour details (unified) ─────────────────────────────
    // Olive-toned header color
    const HEADER_BG = '#8a9a6a';
    const HEADER_FG = '#ffffff';
    const OUTER_BORDER_COLOR = '#888888';

    // Custom layout: outer border only, header gets its own full border
    const outerOnlyLayout = {
      hLineWidth: (i: number, node: any) => {
        // top of table (i===0), bottom of header (i===1), bottom of table (i===last)
        if (i === 0 || i === 1 || i === node.table.body.length) return 1;
        return 0;
      },
      vLineWidth: (i: number, node: any) => {
        // only leftmost and rightmost vertical lines
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
      // Header row
      [
        { text: t('INVOICE.DESCRIPTION'), style: 'tableHeader', color: HEADER_FG },
        { text: t('INVOICE.QUANTITY'),    style: 'tableHeader', color: HEADER_FG, alignment: 'right' },
        { text: t('TOUR.UNIT_PRICE'),     style: 'tableHeader', color: HEADER_FG, alignment: 'right' },
        { text: t('INVOICE.VAT'),         style: 'tableHeader', color: HEADER_FG, alignment: 'right' },
        { text: t('TOUR.TOTAL'),          style: 'tableHeader', color: HEADER_FG, alignment: 'right' }
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
    // Treffpunkt always shown as '-'
    tourDetailLines.push({
      text: [{ text: '· Treffpunkt: ', bold: true }, { text: '-' }],
      fontSize: 9, color: '#555555', margin: [0, 1, 0, 0]
    });
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

    // Line item rows — numbered, no tour details here
    invoice.lineItems.forEach((item, index) => {
      tableBody.push([
        { text: `${index + 1}. ${item.description}`, style: 'tableCell' },
        { text: item.quantity.toString(),                         style: 'tableCell', alignment: 'right' },
        { text: this.formatCurrency(item.unitPriceNet, lang),     style: 'tableCell', alignment: 'right' },
        { text: this.formatVat(item.vatPercentage, lang),         style: 'tableCell', alignment: 'right' },
        { text: this.formatCurrency(item.lineTotalGross, lang),   style: 'tableCell', alignment: 'right' }
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

    // ── 5. VAT SUMMARY ────────────────────────────────────────────────────────
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

    content.push({
      table: { widths: ['*', 'auto'], body: summaryTable },
      layout: 'noBorders',
      margin: [300, 0, 0, 20]
    });

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

    // Helper to build a stack line: "Label: value" where label is bold
    const footerLine = (label: string, value: string) => ({
      text: [
        { text: `${label}: `, ...footerLabelStyle },
        { text: value, ...footerTextStyle }
      ]
    });

    // Column 1 — Company address
    const col1: any[] = [];
    if (settings.companyName)   col1.push({ text: settings.companyName, ...footerTextStyle });
    if (settings.companyAddress) col1.push({ text: settings.companyAddress, ...footerTextStyle });
    if (settings.cityCountry)   col1.push({ text: settings.cityCountry, ...footerTextStyle });

    // Column 2 — Bank details
    const col2: any[] = [];
    if (settings.bankName)      col2.push(footerLine('Bankverbindung', settings.bankName));
    if (settings.accountHolder) col2.push(footerLine('Kontoinhaber', settings.accountHolder));
    if (settings.iban)          col2.push(footerLine('IBAN', settings.iban));
    if (settings.bic)           col2.push(footerLine('BIC', settings.bic));

    // Column 3 — Legal details
    const col3: any[] = [];
    if (settings.legalForm)          col3.push(footerLine('Firma & Rechtsform', settings.legalForm));
    if (settings.headquarters)       col3.push(footerLine('Firmensitz', settings.headquarters));
    if (settings.courtRegistry)      col3.push(footerLine('FB-Gericht', settings.courtRegistry));
    if (settings.registrationNumber) col3.push(footerLine('FB-Nummer', settings.registrationNumber));

    // Thin separator line above footer
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