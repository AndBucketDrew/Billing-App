/**
 * Unit tests for the invoice field parser, run against the text layers of the 8 real
 * example invoices the user receives (Austrian/German "Rechnung" PDFs). These lock in
 * the payee/amount/IBAN heuristics so future tweaks don't regress real-world accuracy.
 *
 * The parser lives in the Electron layer but is pure (no I/O), so it runs unchanged in
 * the Karma/browser test environment.
 */
import {
  parseInvoiceFields,
  parseAmount,
  OwnCompany,
} from '../../../../electron/invoice-parser/invoice-field-parser';

const OWN: OwnCompany = {
  companyName: 'Good Vienna Tours',
  iban: '',
  vatNumber: 'ATU70953845',
  accountHolder: 'Good Vienna Tours GmbH',
};

describe('parseAmount', () => {
  it('parses German decimal comma', () => expect(parseAmount('936,00')).toBe(936));
  it('parses German thousands + decimal', () => expect(parseAmount('1.760,72')).toBe(1760.72));
  it('parses English dot-decimal', () => expect(parseAmount('343.06')).toBe(343.06));
  it('parses English thousands + decimal', () => expect(parseAmount('1,760.72')).toBe(1760.72));
  it('parses a bare integer', () => expect(parseAmount('2400')).toBe(2400));
  it('treats a lone dotted-thousands group as integer', () => expect(parseAmount('1.760')).toBe(1760));
});

describe('parseInvoiceFields — amount tokenizer edge cases', () => {
  it('ignores negative amounts (discounts/deposits), even across a currency symbol', () => {
    const text = `Vendor GmbH
Zwischensumme € 1.467,27
Jahresrabatt 15 % − € 246,60
Gesamt € 1.760,72`;
    const r = parseInvoiceFields(text, OWN, 'Vendor GmbH');
    expect(r.amount).toBe(1760.72); // not 246.60, and never a negative
  });

  it('does not read a date component (11.06.2026) as an amount', () => {
    const text = `Vendor GmbH
Wien, 11.06.2026
Gesamtbetrag 50,00`;
    const r = parseInvoiceFields(text, OWN, 'Vendor GmbH');
    expect(r.amount).toBe(50);
  });

  it('splits glued German columns and never invents a glued number', () => {
    const text = `Vendor GmbH
185,0037,00222,00
750,00150,00900,00
Gesamt 900,00`;
    const r = parseInvoiceFields(text, OWN, 'Vendor GmbH');
    expect(r.amount).toBe(900);
  });

  it('recovers a labeled round-integer total with no currency mark on its line', () => {
    const text = `Vendor GmbH
Leistung Stadtführung 5 pax
Gesamtbetrag 2400`;
    const r = parseInvoiceFields(text, OWN, 'Vendor GmbH');
    expect(r.amount).toBe(2400); // dropped before — no decimals and no € on the line
  });

  it('does not grab a bare reference number sharing the labeled total line', () => {
    const text = `Vendor GmbH
Gesamtbetrag Rechnung 554117 50,00`;
    const r = parseInvoiceFields(text, OWN, 'Vendor GmbH');
    // 554117 has no decimals/currency so the monetary filter drops it; the decimal
    // total wins, and the round-integer recovery is skipped (line isn't a sole number).
    expect(r.amount).toBe(50);
  });
});

describe('parseInvoiceFields — date labels', () => {
  it('reads invoice and due dates that share a single line', () => {
    const text = `Vendor GmbH
Rechnungsdatum: 11.06.2026  Fällig: 18.06.2026`;
    const r = parseInvoiceFields(text, OWN, 'Vendor GmbH');
    expect(r.invoiceDate).toBe('2026-06-11');
    expect(r.dueDate).toBe('2026-06-18'); // not 2026-06-11 (the first date on the line)
  });
});

describe('parseInvoiceFields — real example invoices', () => {
  it('Cafe Drei Husaren (554117): Summe 100,00 EUR, no IBAN', () => {
    const text = `Cafe Drei Husaren GmbH
Kärntnerstraße 13-15
1010 Wien
Good Vienna Tours
Himmelpfortgasse 11/1/25a
1010 Wien
Sammelrechnung Nr: 554117 11.06.2026
Summe 96,00
Tip: 4,00
Summe: 100,00 EUR
ATU65163967`;
    const r = parseInvoiceFields(text, OWN, 'Cafe Drei Husaren GmbH');
    expect(r.amount).toBe(100);
    expect(r.iban).toBeNull();
    expect(r.bic).toBeNull();
    expect(r.payee).toContain('Cafe Drei Husaren');
    expect(r.invoiceNumber).toBe('554117');
  });

  it('austriaguides (43/2026): Total 1.950,00 €, AT25 IBAN, payee not truncated', () => {
    const text = `GOOD VIENNA TOURS GmbH
Himmelpfortgasse 11/1/25A
A - 1010 Wien
Rechnung Nr. 43/2026
18.05.2026 Private Tour Schönbrunn 195,00 €
Total 1.950,00 €
IBAN: AT25 2011 1283 4034 4602
BIC: GIBAATWWXXX
Mit freundlichen Grüßen
Antonija Recnik`;
    const r = parseInvoiceFields(text, OWN, 'Antonija Recnik');
    expect(r.amount).toBe(1950);
    expect(r.iban).toBe('AT252011128340344602');
    expect(r.bic).toBe('GIBAATWWXXX');
    expect(r.payee).toBe('Antonija Recnik');
  });

  // Mirabell's real text layer GLUES the total label to two numbers ("Total343.06343.06")
  // and lists negative deposit lines. The parser must (a) pull the labeled Total 343.06 out
  // of the glued blob (the correct amount to pay), (b) NOT fall back to the 376.66 line item,
  // (c) never emit a negative or glued garbage like 6343.06.
  it('Mirabell (real glued text): extracts labeled Total 343.06 from glued blob', () => {
    const text = `Good Vienna Tours
ATU70953845
INVOICE Date 12.06.2026
12.06.26 No Show Fee376.66
11.06.26 Deposit VAT 10%-33.60
Total343.06343.06
Balance 0.00
Deposit VAT 10%-335.96-67.20-403.16
Gala Master Austria GmbH
Raiffeisenlandesbank NÖ-Wien AG IBAN: AT12 3200 0000 0033 1801 BIC: RLNWATWW`;
    const r = parseInvoiceFields(text, OWN, 'master MIRABELL');
    expect(r.amount).toBe(343.06);            // labeled Total, NOT 376.66 / 403.16 / 6343.06
    expect(r.iban).toBe('AT123200000000331801');
    expect(r.bic).toBe('RLNWATWW');            // pulled from after the BIC label, not the IBAN
  });

  it('wolftrax (018/2026): Gesamtbetrag 936,00, AT84 IBAN', () => {
    const text = `Wolfgang Christian
staatl. gepr. Fremdenführer
IBAN: AT842081500043189620
BIC: STSPAT2GXXX
Good Vienna Tours
Rechnung: 018/2026
Zwischensumme 780,00
20% Ust 156,00
Gesamtbetrag 936,00`;
    const r = parseInvoiceFields(text, OWN, 'Wolfgang Christian');
    expect(r.amount).toBe(936);
    expect(r.iban).toBe('AT842081500043189620');
    expect(r.bic).toBe('STSPAT2GXXX');
    expect(r.payee).toBe('Wolfgang Christian');
    expect(r.invoiceNumber).toBe('018/2026');
  });

  it('Nissner (2026-190): no-decimal "Gesamt € 2400" not truncated to 240', () => {
    const text = `Anastasiia Nissner
An
Good Vienna Tours GmbH
ATU70953845
Rechnungsnummer: 2026 - 190
Rechnungsdatum: 03.06.2026
Gesamt € 2400 - netto
IBAN: AT221912080795157660
BIC: SPBAATWWB99`;
    const r = parseInvoiceFields(text, OWN, 'Anastasiia Nissner');
    expect(r.amount).toBe(2400);
    expect(r.iban).toBe('AT221912080795157660');
    expect(r.bic).toBe('SPBAATWWB99');
    expect(r.payee).toBe('Anastasiia Nissner');
    expect(r.invoiceDate).toBe('2026-06-03');
  });

  // Real text layer GLUES the columns ("...185,0037,00222,00", "750,00150,00900,00")
  // and the only "total-ish" word is the column header "Brutto" — which must NOT anchor
  // the amount (else it picks the first row, 222). German comma amounts must split when
  // glued, and the grand total 900 wins via the largest-amount fallback.
  it('Lahr (837, real glued text): Brutto header is not a total anchor, splits to 900', () => {
    const text = `Mag. Marco Julien Lahr
IBAN: AT68 1200 0007 0239 1566
BIC: BKAUATWW
An
Good Vienna Tours
Rechnung 837
Netto20 % UstBrutto
10.04.2026, Stadtspaziergang, 5 pax, spanish185,0037,00222,00
13.06.2026, Schönbrunn, 19 pax, spanisch195,0039,00234,00
750,00150,00900,00
Rechnung zahlbar nach Erhalt`;
    const r = parseInvoiceFields(text, OWN, 'Mag. Marco Julien Lahr');
    expect(r.amount).toBe(900);
    expect(r.iban).toBe('AT681200000702391566');
    expect(r.bic).toBe('BKAUATWW');
    expect(r.payee).toBe('Mag. Marco Julien Lahr');
  });

  it('Georg Nicola (2026-171): Gesamt € 1.760,72, Kontoinhaber payee, due date', () => {
    const text = `Georg Nicola Medienverlag
Good Vienna Tours GmbH
RECHNUNG
Nummer 2026-171
Datum 15. Juni 2026
Fällig 22. Juni 2026
Nettobetrag € 1.397,40
Gesamt € 1.760,72
Raiffeisen · IBAN: AT72 3212 3000 0021 3512 · BIC: RLNWATWW123 · Kontoinhaber: Georg Nicola`;
    const r = parseInvoiceFields(text, OWN, 'Georg Nicola Medienverlag');
    expect(r.amount).toBe(1760.72);
    expect(r.iban).toBe('AT723212300000213512');
    // The printed code carries a (numeric) branch group, so the 11-char form is captured
    // whole — the user confirms it in the review step.
    expect(r.bic).toBe('RLNWATWW123');
    expect(r.invoiceNumber).toBe('2026-171');
    expect(r.invoiceDate).toBe('2026-06-15');
    expect(r.dueDate).toBe('2026-06-22');
  });

  it('KHM (F26/1597): Gesamtsumme/Total EUR 40,00, AT18 IBAN before BIC/SWIFT', () => {
    const text = `Good Vienna Tours GmbH
Belegdatum 31. Mai 2026
Fällig am 31. Mai 2026
Rechnung F26/1597
Bankverbindung: BAWAG PSK AG, Konto Nr.: 92 057 968, BLZ: 60000, Iban: AT18 6000 0000 9205 7968 BIC/SWIFT: BAWAATWW
KHM-Museumsverband
4000 Eintritte 1 40,00 10% 40,00
Gesamtsumme EUR 40,00
Total EUR 3,64 EUR 36,36 EUR 40,00`;
    const r = parseInvoiceFields(text, OWN, 'Kunsthistorisches Museum');
    expect(r.amount).toBe(40);
    expect(r.iban).toBe('AT186000000092057968');
    expect(r.bic).toBe('BAWAATWW');               // from a combined "BIC/SWIFT:" label
    expect(r.invoiceNumber).toBe('F26/1597');
  });

  // .docx HONORARNOTE (Daniela Jahn). Exercises: "Gesamtsumme … EURO 195,00" total,
  // payee = sender (not Good Vienna Tours), and an IBAN printed with a space after the
  // country code ("AT 37 2020 …") which the relaxed IBAN regex must still capture.
  it('docx HONORARNOTE (Daniela Jahn): Gesamtsumme 195, IBAN with space after country code', () => {
    const text = `DANIELA JAHN – AUSTRIA GUIDE
HARTERGASSE 43, 2500 Baden/Wien
Good Vienna Tours
Himmelpfortgasse 11/1/25A
A-1010 Wien
Baden, 09.06.2026
HONORARNOTE UID 56347288
05.06.2026: Schönbrunn englisch EURO 195,00
Gesamtsumme EURO 195,00
Ich ersuche um Überweisung des Betrages auf das Konto von Daniela Jahn,
Sparkasse Baden IBAN: AT 37 2020 5010 0124 2146
BIC: SPBDAT21XXX und danke für die gute Zusammenarbeit.`;
    const r = parseInvoiceFields(text, OWN, 'Daniela Jahn');
    expect(r.amount).toBe(195);
    expect(r.iban).toBe('AT372020501001242146');
    expect(r.bic).toBe('SPBDAT21XXX');
    expect(r.payee).toContain('Daniela Jahn');
  });

  it('Domkirche St. Stephan (054/26): BIC label at end of line, code wrapped to next line', () => {
    const text = `Good Vienna Tours GmbH
Kunden Nr.:207008
UID-Nr.:ATU70953845
Rechnung Nr. 054/26
Rechnungsbetrag brutto:€ 214,00
Wir ersuchen um Überweisung des Betrages an IBAN: AT95 1919 0000 0016 8153, BIC:
BSSWATWW, lautend auf Domkirche St. Stephan.`;
    const r = parseInvoiceFields(text, OWN, undefined);
    expect(r.amount).toBe(214);
    expect(r.iban).toBe('AT951919000000168153');
    expect(r.bic).toBe('BSSWATWW');            // label ends one line, code starts the next
    expect(r.invoiceNumber).toBe('054/26');
  });

  it('returns nulls and EUR default for empty text (no text layer)', () => {
    const r = parseInvoiceFields('', OWN, 'Some Vendor');
    expect(r.amount).toBeNull();
    expect(r.iban).toBeNull();
    expect(r.bic).toBeNull();
    expect(r.payee).toBe('Some Vendor'); // falls back to the email sender name
    expect(r.currency).toBe('EUR');
  });

  it('never returns the user\'s own company as the payee', () => {
    const text = `Good Vienna Tours GmbH
Himmelpfortgasse 11/1/25
Rechnung 999
Gesamt 50,00`;
    const r = parseInvoiceFields(text, OWN, 'Good Vienna Tours GmbH');
    expect(r.payee === null || !/good vienna tours/i.test(r.payee)).toBeTrue();
  });
});
