import { Injectable } from '@angular/core';
import { CompanySettings } from '../models/domain.models';
import { InvoiceReviewItem } from '../models/outlook.models';

/** One creditor transaction that could not be included, with the reason why. */
export interface SkippedPayment {
  payee: string;
  reason: string;
}

export interface SepaExportResult {
  /** Number of credit-transfer transactions written to the file. */
  count: number;
  /** Total of all included transactions (EUR). */
  total: number;
  /** Items left out because they were missing required data. */
  skipped: SkippedPayment[];
}

/**
 * Builds a SEPA credit-transfer file (ISO 20022 pain.001.001.03) from the parsed
 * "Invoices to Pay" rows, ready to upload to online banking.
 *
 * Why XML and not the Excel sheet: banks import payments via the pain.001 XML
 * schema, not spreadsheets. Feeding an .xlsx (a binary ZIP) into the bank's XML
 * importer is what produced the "premature end of file" parse error.
 *
 * Scope: SEPA only - EUR transactions to an IBAN within the SEPA area. The debtor
 * (the account that pays) comes from CompanySettings; each creditor comes from a
 * confirmed parsed invoice.
 */
@Injectable({ providedIn: 'root' })
export class SepaExportService {

  async exportPayments(items: InvoiceReviewItem[], company: CompanySettings): Promise<SepaExportResult> {
    const debtorName = (company.accountHolder || company.companyName || '').trim();
    const debtorIban = (company.iban || '').replace(/\s+/g, '').toUpperCase();
    const debtorBic = (company.bic || '').replace(/\s+/g, '').toUpperCase();

    if (!debtorIban) {
      throw new Error('Your company IBAN is not set. Add it under Settings -> Bank details before exporting a SEPA file.');
    }
    if (!debtorName) {
      throw new Error('Your account holder / company name is not set. Add it under Settings -> Bank details before exporting a SEPA file.');
    }

    const skipped: SkippedPayment[] = [];
    const valid: { item: InvoiceReviewItem; payee: string; iban: string; bic: string; amount: number; remittance: string; endToEndId: string }[] = [];

    for (const item of items) {
      const f = item.parsedFields;
      const payee = (f?.payee ?? '').trim() || '(unknown payee)';
      const iban = (f?.iban ?? '').replace(/\s+/g, '').toUpperCase();
      const bic = (f?.bic ?? '').replace(/\s+/g, '').toUpperCase();
      // Round to whole cents up front so the per-transaction amounts and the control
      // sum are computed from the same integer-cent values (see buildXml / total).
      const amount = Math.round((f?.amount ?? 0) * 100) / 100;
      const currency = (f?.currency ?? 'EUR').toUpperCase() || 'EUR';

      if (!iban) { skipped.push({ payee, reason: 'no IBAN' }); continue; }
      if (!(amount > 0)) { skipped.push({ payee, reason: 'no/zero amount' }); continue; }
      if (currency !== 'EUR') { skipped.push({ payee, reason: `non-EUR (${currency}) - SEPA is EUR only` }); continue; }

      valid.push({
        item,
        payee,
        iban,
        bic,
        amount,
        remittance: (f?.invoiceNumber ?? '').trim(),
        // 1-based position guarantees a unique EndToEndId even when invoices share a
        // number or have none — banks reject batches with duplicate references.
        endToEndId: this.makeEndToEndId(f?.invoiceNumber ?? '', valid.length + 1),
      });
    }

    // No eligible row is not an error: the Excel sheet (written by the caller first)
    // still holds every row. Return an empty result — no XML file is written and no
    // save dialog is shown — so the caller can finish cleanly and still flag exported.
    if (valid.length === 0) {
      return { count: 0, total: 0, skipped };
    }

    // Sum in integer cents so CtrlSum exactly equals the sum of the (rounded) InstdAmt
    // values; summing floats directly can leave the two off by a cent and the bank
    // rejects the whole file.
    const totalCents = valid.reduce((sum, p) => sum + Math.round(p.amount * 100), 0);
    const total = totalCents / 100;
    const xml = this.buildXml({ debtorName, debtorIban, debtorBic }, valid, total);

    const filename = `sepa-payments-${this.ymd(new Date())}.xml`;
    const saved = await (window as any).electronAPI.sepa.save(xml, filename);
    if (saved === null) throw new Error('Export cancelled');

    return { count: valid.length, total, skipped };
  }

  private buildXml(
    debtor: { debtorName: string; debtorIban: string; debtorBic: string },
    payments: { payee: string; iban: string; bic: string; amount: number; remittance: string; endToEndId: string }[],
    total: number,
  ): string {
    const now = new Date();
    const creDtTm = now.toISOString().replace(/\.\d{3}Z$/, '');     // yyyy-mm-ddThh:mm:ss
    // Roll the requested execution date forward off weekends — strict bank importers
    // reject a non-business-day ReqdExctnDt instead of shifting it themselves.
    const reqdExctnDt = this.ymd(this.nextBusinessDay(now));        // yyyy-mm-dd
    const msgId = this.makeId('BILL', now);
    const pmtInfId = this.makeId('PMT', now);
    const nbOfTxs = payments.length.toString();
    const ctrlSum = this.money(total);

    const debtorAgt = debtor.debtorBic
      ? `        <DbtrAgt><FinInstnId><BIC>${this.esc(debtor.debtorBic)}</BIC></FinInstnId></DbtrAgt>`
      : `        <DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>`;

    const txns = payments.map(p => {
      const cdtrAgt = p.bic
        ? `\n          <CdtrAgt><FinInstnId><BIC>${this.esc(p.bic)}</BIC></FinInstnId></CdtrAgt>`
        : '';
      const rmtInf = p.remittance
        ? `\n          <RmtInf><Ustrd>${this.esc(this.text(p.remittance, 140))}</Ustrd></RmtInf>`
        : '';
      return `        <CdtTrfTxInf>
          <PmtId><EndToEndId>${this.esc(p.endToEndId)}</EndToEndId></PmtId>
          <Amt><InstdAmt Ccy="EUR">${this.money(p.amount)}</InstdAmt></Amt>${cdtrAgt}
          <Cdtr><Nm>${this.esc(this.name(p.payee))}</Nm></Cdtr>
          <CdtrAcct><Id><IBAN>${this.esc(p.iban)}</IBAN></Id></CdtrAcct>${rmtInf}
        </CdtTrfTxInf>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${this.esc(msgId)}</MsgId>
      <CreDtTm>${creDtTm}</CreDtTm>
      <NbOfTxs>${nbOfTxs}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <InitgPty><Nm>${this.esc(this.name(debtor.debtorName))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${this.esc(pmtInfId)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <NbOfTxs>${nbOfTxs}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${reqdExctnDt}</ReqdExctnDt>
      <Dbtr><Nm>${this.esc(this.name(debtor.debtorName))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${this.esc(debtor.debtorIban)}</IBAN></Id></DbtrAcct>
${debtorAgt}
      <ChrgBr>SLEV</ChrgBr>
${txns}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
  }

  /** Two-decimal amount with a dot separator, as required by pain.001. */
  private money(value: number): string {
    return value.toFixed(2);
  }

  /** Escapes the five XML special characters. */
  private esc(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Restricts text to the SEPA-permitted Latin character set, collapses whitespace
   * and truncates. Common German/accented letters are transliterated (ae, ue, ss, ...)
   * rather than dropped so payee names stay readable; anything still outside the set
   * becomes a space so the bank's importer doesn't reject the message.
   */
  private text(value: string, max: number): string {
    return this.transliterate(value)
      .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  /** Maps accented Latin letters to their SEPA-safe ASCII equivalents. */
  private transliterate(value: string): string {
    const map: Record<string, string> = {
      'ä': 'ae', 'ö': 'oe', 'ü': 'ue',
      'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss',
      'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'å': 'a',
      'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
      'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
      'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o',
      'ú': 'u', 'ù': 'u', 'û': 'u',
      'ç': 'c', 'ñ': 'n',
      'š': 's', 'ž': 'z', 'č': 'c', 'ć': 'c', 'đ': 'd',
      'Á': 'A', 'À': 'A', 'Â': 'A', 'É': 'E', 'È': 'E',
      'Í': 'I', 'Ó': 'O', 'Ô': 'O', 'Ú': 'U', 'Ç': 'C', 'Ñ': 'N',
    };
    // Pass ASCII through untouched; map known accents, replace any other non-ASCII with a space.
    return value.replace(/[^\x00-\x7F]/g, ch => map[ch] ?? ' ');
  }

  /** Party names are capped at 70 chars per the SEPA scheme. */
  private name(value: string): string {
    return this.text(value, 70) || 'NOTPROVIDED';
  }

  /**
   * EndToEndId: SEPA-clean, unique per transaction, max 35 chars, never empty.
   * The index suffix keeps it unique even when invoices share a number or have none.
   */
  private makeEndToEndId(invoiceNumber: string, index: number): string {
    const base = this.text(invoiceNumber, 30) || 'NOTPROVIDED';
    return `${base}-${index}`.slice(0, 35);
  }

  /** Formats a Date as a local yyyy-mm-dd (avoids the UTC off-by-one of toISOString). */
  private ymd(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /** Nearest business day on or after the given date (Sat→Mon, Sun→Mon). */
  private nextBusinessDay(d: Date): Date {
    const r = new Date(d);
    const wd = r.getDay();
    if (wd === 6) r.setDate(r.getDate() + 2);
    else if (wd === 0) r.setDate(r.getDate() + 1);
    return r;
  }

  /** Unique, schema-legal id (max 35 chars). */
  private makeId(prefix: string, now: Date): string {
    const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `${prefix}-${stamp}-${rand}`.slice(0, 35);
  }
}
