/**
 * invoice-field-parser — pure heuristic extraction of "who to pay / how much" from
 * an invoice's plain-text layer. No I/O, no network — fully unit-testable.
 *
 * Shared between the Electron layer and the Angular renderer (re-exported through
 * the outlook models barrel), mirroring how invoice-detector.ts is shared.
 *
 * The single most reliable signal is "subtract self": these invoices are all
 * addressed TO the user's own company, so the payee is whichever party is NOT the
 * user. The caller passes the user's identity (from CompanySettings) as `own`.
 *
 * Heuristics are tuned against the 8 real Austrian/German example invoices — see
 * invoice-field-parser.spec.ts. Output is always presented to the user for review
 * before export, so "best guess + confidence flag" is the design target, not
 * perfect extraction.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export type FieldConfidence = 'high' | 'medium' | 'low';

export interface ParsedInvoiceFields {
  /** Who to pay — the vendor/sender, never the user's own company. */
  payee: string | null;
  /** Vendor IBAN (spaces stripped), excluding the user's own IBAN. */
  iban: string | null;
  /** Vendor BIC/SWIFT code (8 or 11 chars), when printed near a BIC/SWIFT label. */
  bic: string | null;
  /** Gross/total amount to pay. */
  amount: number | null;
  /** ISO 4217-ish currency code; defaults to 'EUR'. */
  currency: string;
  invoiceNumber: string | null;
  /** ISO date (yyyy-mm-dd). */
  invoiceDate: string | null;
  /** ISO date (yyyy-mm-dd). */
  dueDate: string | null;
  fieldConfidence: { payee: FieldConfidence; amount: FieldConfidence };
  /** The raw text we matched the amount from — shown in the review UI. */
  rawAmountText: string | null;
}

/** The user's own company identity, used to exclude self from payee/IBAN detection. */
export interface OwnCompany {
  companyName: string;
  iban: string;
  vatNumber: string;
  accountHolder: string;
}

// ─── Keyword lists ──────────────────────────────────────────────────────────────

/**
 * Total-amount labels, ordered loosely strongest → weakest. Deliberately excludes
 * "Brutto"/"Netto", which appear as column *headers* in these invoices (e.g.
 * "Netto 20% Ust Brutto") and would wrongly anchor on a line item rather than the
 * grand total. The largest-amount fallback covers label-less grand totals instead.
 */
const TOTAL_KEYWORDS = [
  'gesamtbetrag', 'gesamtsumme', 'rechnungsbetrag', 'zu zahlen', 'zahlbetrag',
  'gesamt', 'summe', 'total', 'amount due', 'amount payable',
];

const PAYEE_HOLDER_LABELS = ['kontoinhaber', 'account holder', 'kontoinhaberin', 'inhaber'];

const INVOICE_NO_LABELS = [
  'rechnungsnummer', 'rechnungs-nr', 'rechnung nr', 'invoice no', 'invoice number',
  'rechnung', 'nummer', 'beleg-nr', 'belegnummer', 'nr',
];

const INVOICE_DATE_LABELS = ['rechnungsdatum', 'belegdatum', 'invoice date', 'datum', 'date'];
const DUE_DATE_LABELS = ['fällig am', 'fällig', 'zahlbar bis', 'due date', 'due'];

const GERMAN_MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

/** Generic words that should never be treated as a payee name. */
const PAYEE_STOPWORDS = [
  'rechnung', 'invoice', 'an', 'bill to', 'rechnungsempfänger', 'kunde', 'datum',
  'sehr geehrte', 'leistung', 'beschreibung', 'bankverbindung',
];

// ─── Main entry point ───────────────────────────────────────────────────────────

export function parseInvoiceFields(
  text: string,
  own: OwnCompany,
  senderName?: string,
): ParsedInvoiceFields {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const iban = findIban(lines, own);
  const bic = findBic(lines);
  const { payee, confidence: payeeConfidence } = findPayee(lines, own, senderName, iban);
  const { amount, currency, rawAmountText, confidence: amountConfidence } = findAmount(lines);

  return {
    payee,
    iban,
    bic,
    amount,
    currency,
    invoiceNumber: findInvoiceNumber(lines),
    invoiceDate: findDate(lines, INVOICE_DATE_LABELS),
    dueDate: findDate(lines, DUE_DATE_LABELS),
    fieldConfidence: { payee: payeeConfidence, amount: amountConfidence },
    rawAmountText,
  };
}

// ─── IBAN ─────────────────────────────────────────────────────────────────────

/**
 * Matches an IBAN with optional internal spaces: 2 letters, an optional space (some
 * invoices print "AT 37 2020…"), 2 check digits, then 11–30 grouped alphanumerics.
 */
const IBAN_RE = /\b([A-Z]{2}\s?\d{2}(?:\s?[A-Z0-9]){11,30})\b/g;

/**
 * Fixed national IBAN lengths. Printed IBANs are grouped in 4s and often immediately
 * followed by a "BIC" label, which the greedy regex would otherwise absorb. Truncating
 * to the country's known length removes that trailing noise (e.g. "…331801BIC" → "…331801").
 */
const IBAN_LENGTHS: Record<string, number> = {
  AT: 20, DE: 22, CH: 21, LI: 21, IT: 27, FR: 27, ES: 24, NL: 18,
  BE: 16, LU: 20, GB: 22, CZ: 24, SK: 24, HU: 28, SI: 19, PL: 28,
};

function findIban(lines: string[], own: OwnCompany): string | null {
  const ownIban = normalizeIban(own.iban);
  const found: string[] = [];

  for (const line of lines) {
    const matches = line.toUpperCase().matchAll(IBAN_RE);
    for (const m of matches) {
      let candidate = normalizeIban(m[1]);
      const expected = IBAN_LENGTHS[candidate.slice(0, 2)];
      if (expected && candidate.length > expected) candidate = candidate.slice(0, expected);
      if (candidate.length >= 15 && candidate.length <= 34) {
        found.push(candidate);
      }
    }
  }

  // Rank candidates: prefer (1) not-own + checksum-valid, (2) not-own, (3) checksum-valid,
  // (4) anything. mod-97 is only a preference, never a hard reject — some real-world
  // invoices carry IBANs that fail the checksum, and dropping a real IBAN is worse than
  // surfacing a questionable one for the user to confirm in the review step.
  const notOwn = found.filter(c => c !== ownIban);
  const pool = notOwn.length > 0 ? notOwn : found;
  return pool.find(isPlausibleIban) ?? pool[0] ?? null;
}

function normalizeIban(raw: string): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Lightweight mod-97 IBAN check — rejects random alphanumeric runs that match the shape. */
function isPlausibleIban(iban: string): boolean {
  // Move the first 4 chars to the end, then convert letters to numbers (A=10…Z=35).
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const digit of code) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

// ─── BIC / SWIFT ──────────────────────────────────────────────────────────────

/**
 * BIC/SWIFT shape: 4-letter bank code, 2-letter ISO country, 2 alphanumeric location,
 * then an optional 3 alphanumeric branch — 8 or 11 chars total (e.g. "BKAUATWW" or
 * "GIBAATWWXXX"). The greedy optional branch means a labeled code is captured whole.
 */
const BIC_RE = /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/;

/**
 * Pulls the vendor BIC, but only from a line that carries a "BIC"/"SWIFT" label and only
 * from the text *after* that label. Anchoring to the label avoids matching the IBAN or
 * other uppercase runs (e.g. company names) that happen to fit the BIC shape.
 *
 * Invoices sometimes wrap the value onto the next line ("…, BIC:\nBSSWATWW, lautend…"),
 * so when nothing follows the label on its own line we fall through to the start of the
 * next line. We anchor to the line start there to avoid grabbing an unrelated uppercase
 * run further down the document.
 */
function findBic(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const upper = lines[i].toUpperCase();
    const labelMatch = upper.match(/BIC(?:\/SWIFT)?|SWIFT/);
    if (!labelMatch || labelMatch.index === undefined) continue;

    const after = upper.slice(labelMatch.index + labelMatch[0].length);
    const m = after.match(BIC_RE);
    if (m) return m[0];

    // Label at end of line — the code wrapped to the next line.
    const next = lines[i + 1]?.toUpperCase() ?? '';
    const wrapped = next.match(new RegExp('^\\s*(' + BIC_RE.source + ')'));
    if (wrapped) return wrapped[1];
  }
  return null;
}

// ─── Payee ──────────────────────────────────────────────────────────────────────

function findPayee(
  lines: string[],
  own: OwnCompany,
  senderName: string | undefined,
  iban: string | null,
): { payee: string | null; confidence: FieldConfidence } {
  const isSelf = makeSelfMatcher(own);

  // (a) Value after a "Kontoinhaber:" / "Account holder:" label — the strongest signal.
  const holder = findLabeledValue(lines, PAYEE_HOLDER_LABELS);
  if (holder && !isSelf(holder) && !isStopword(holder)) {
    return { payee: cleanName(holder), confidence: iban ? 'high' : 'medium' };
  }

  // (b) Email sender display name — strong and free, when it isn't the user themselves.
  if (senderName && senderName.trim() && !isSelf(senderName) && !isStopword(senderName)) {
    return { payee: cleanName(senderName), confidence: iban ? 'high' : 'medium' };
  }

  // (c) First top-of-document text line that isn't the user's company or a generic word.
  //     The vendor letterhead is almost always at the very top.
  for (const line of lines.slice(0, 8)) {
    if (isSelf(line) || isStopword(line)) continue;
    if (looksLikeAddressOrNumber(line)) continue;
    if (line.length < 3 || line.length > 70) continue;
    return { payee: cleanName(line), confidence: iban ? 'medium' : 'low' };
  }

  // (d) Name after a "Mit freundlichen Grüßen" sign-off.
  const greetingIdx = lines.findIndex(l => /mit freundlichen gr(ü|u)(ß|ss)en/i.test(l));
  if (greetingIdx >= 0) {
    for (const line of lines.slice(greetingIdx + 1, greetingIdx + 4)) {
      if (line && !isSelf(line) && !isStopword(line) && !looksLikeAddressOrNumber(line)) {
        return { payee: cleanName(line), confidence: 'low' };
      }
    }
  }

  return { payee: null, confidence: 'low' };
}

/** Builds a predicate that returns true when a line refers to the user's own company. */
function makeSelfMatcher(own: OwnCompany): (s: string) => boolean {
  const needles = [own.companyName, own.accountHolder, own.vatNumber]
    .map(n => normalizeName(n))
    .filter(n => n.length >= 3);
  return (s: string) => {
    const hay = normalizeName(s);
    return needles.some(n => hay.includes(n));
  };
}

function isStopword(s: string): boolean {
  const lower = s.toLowerCase().trim();
  return PAYEE_STOPWORDS.some(w => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ':'));
}

/** Strips leading labels ("An", "Kontoinhaber:") and trailing punctuation from a name. */
function cleanName(s: string): string {
  return s
    // Only strip a label when it's a whole word (followed by a separator) — otherwise
    // "An" would be chopped off the start of names like "Antonija" / "Anastasiia".
    .replace(/^(an|bill to|kontoinhaber(in)?|account holder|inhaber)(?=[:\s.\-])[:\s.\-]*/i, '')
    .replace(/[•·∙|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function looksLikeAddressOrNumber(line: string): boolean {
  // Lines that are mostly digits, postal codes, phone numbers, emails, URLs, or VAT ids.
  if (/^\+?\d[\d\s/\-().]{5,}$/.test(line)) return true;       // phone / number run
  if (/\b\d{4,5}\s+\w+/.test(line) && /stra(ß|ss)e|gasse|weg|platz/i.test(line)) return true; // street + zip
  if (/@/.test(line) || /https?:\/\/|www\./i.test(line)) return true;
  if (/^atu?\s?\d/i.test(line)) return true;                   // Austrian VAT id
  if (/^\d{4,}/.test(line)) return true;                       // starts with a long number
  return false;
}

// ─── Amount ───────────────────────────────────────────────────────────────────

interface AmountHit { value: number; raw: string; labeled: boolean; }

function findAmount(lines: string[]): {
  amount: number | null;
  currency: string;
  rawAmountText: string | null;
  confidence: FieldConfidence;
} {
  const labeledHits: AmountHit[] = [];
  const allHits: AmountHit[] = [];
  const labeledIntegerHits: AmountHit[] = [];

  for (const line of lines) {
    const hasTotalKeyword = TOTAL_KEYWORDS.some(kw => line.toLowerCase().includes(kw));
    for (const num of extractNumbers(line)) {
      if (num.value <= 0) continue; // ignore zero (extractNumbers already drops negatives)
      allHits.push({ value: num.value, raw: num.raw, labeled: hasTotalKeyword });
      if (hasTotalKeyword) labeledHits.push({ value: num.value, raw: num.raw, labeled: true });
    }

    // Round-integer grand totals: a labeled line like "Gesamtbetrag 2400" (no decimals,
    // no currency mark) is dropped by extractNumbers' monetary filter. Recover it as a
    // mid-tier candidate — but only when it's the line's sole number, so we don't grab an
    // invoice/reference number that happens to share the line with the amount.
    if (hasTotalKeyword) {
      const relaxed = extractNumbers(line, true).filter(n => n.value > 0);
      if (relaxed.length === 1) {
        labeledIntegerHits.push({ value: relaxed[0].value, raw: relaxed[0].raw, labeled: true });
      }
    }
  }

  const currency = detectCurrency(lines);

  // Prefer the largest labeled total (gross > net when both sit on labeled lines).
  if (labeledHits.length > 0) {
    const best = labeledHits.reduce((a, b) => (b.value > a.value ? b : a));
    return { amount: best.value, currency, rawAmountText: best.raw, confidence: 'high' };
  }

  // A labeled round-integer total beats any unlabeled line item below.
  if (labeledIntegerHits.length > 0) {
    const best = labeledIntegerHits.reduce((a, b) => (b.value > a.value ? b : a));
    return { amount: best.value, currency, rawAmountText: best.raw, confidence: 'medium' };
  }

  // Fallback: largest positive currency amount anywhere (covers label-less tables).
  if (allHits.length > 0) {
    const best = allHits.reduce((a, b) => (b.value > a.value ? b : a));
    return { amount: best.value, currency, rawAmountText: best.raw, confidence: 'low' };
  }

  return { amount: null, currency, rawAmountText: null, confidence: 'low' };
}

/**
 * Currency-tagged number, matched AFTER dates have been masked out (see extractNumbers).
 * With dates gone, the decimal forms need no boundary guards, so glued table columns split
 * naturally on consecutive matches. Alternatives ordered most-specific first; decimals are
 * exactly 2 digits (cents), which is what lets "343.06343.06" tile into two 343.06 tokens:
 *   1. German thousands+decimal  1.760,72
 *   2. English thousands+decimal 1,760.72
 *   3. German decimal            936,00   — splits "750,00150,00900,00"
 *   4. dot decimal               343.06   — splits "343.06343.06"
 *   5. integer                   2400     — only kept when the line carries a currency mark
 * Note: no space-grouped form — spaces only appear in IBANs / Konto numbers we must ignore.
 */
const NUMBER_RE = /(?:€|eur|usd|\$)?\s*(\d{1,3}(?:\.\d{3})+,\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}|\d+,\d{2}|\d+\.\d{2}|\d+)\s*(?:€|eur|usd|\$)?/gi;

/** Date forms to blank out before number extraction so they're never read as money. */
const DATE_MASK_RE = /\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b|\b\d{1,2}\.\d{1,2}\.(?!\d)/g;

interface NumberToken { value: number; raw: string; }

function extractNumbers(rawLine: string, allowBareInteger = false): NumberToken[] {
  const tokens: NumberToken[] = [];
  const hasCurrency = /€|eur|usd|\$/i.test(rawLine);
  // Mask dates (replacing with same-length spaces keeps match offsets meaningful for the
  // negative-sign lookback below) so "11.06.2026" can never be mistaken for an amount.
  const line = rawLine.replace(DATE_MASK_RE, d => ' '.repeat(d.length));

  for (const m of line.matchAll(NUMBER_RE)) {
    const raw = m[1];
    // Skip negative amounts (deposits, discounts, credits): a "-" or Unicode "−" just
    // before the token — possibly across a currency symbol, e.g. "− € 246,60".
    const before = line.slice(Math.max(0, (m.index ?? 0) - 3), m.index ?? 0);
    if (/[-−]/.test(before)) continue;
    // Skip bare integers with no currency context and no decimals — likely counts,
    // pax numbers, reference codes, etc. Keep them only when the line carries a currency
    // mark, or the caller opted in (allowBareInteger — used to recover labeled round totals).
    const looksMonetary = /[.,]\d{2}$/.test(raw) || hasCurrency || allowBareInteger;
    if (!looksMonetary) continue;
    const value = parseAmount(raw);
    if (value !== null) tokens.push({ value, raw: m[0].trim() });
  }
  return tokens;
}

/**
 * Parses a number string in either German (1.760,72) or English (343.06 / 1,760.72)
 * format. The decimal separator is decided by the LAST separator in the string.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s/g, '');
  if (!s) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the rightmost is the decimal separator, the other groups thousands.
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');   // 1.760,72 → 1760.72
    } else {
      s = s.replace(/,/g, '');                       // 1,760.72 → 1760.72
    }
  } else if (lastComma >= 0) {
    // Only commas. Two trailing digits → decimal comma; otherwise thousands grouping.
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot >= 0) {
    // Only dots. A single dot with 1–2 trailing digits is decimal (343.06); multiple
    // dots or 3 trailing digits is thousands grouping (1.760 → 1760).
    const dotCount = (s.match(/\./g) || []).length;
    if (dotCount === 1 && /\.\d{1,2}$/.test(s)) {
      /* decimal dot — leave as is */
    } else {
      s = s.replace(/\./g, '');
    }
  }

  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

function detectCurrency(lines: string[]): string {
  const joined = lines.join(' ');
  if (/\$|usd/i.test(joined) && !/€|eur/i.test(joined)) return 'USD';
  return 'EUR'; // default for this Austrian/German workflow
}

// ─── Invoice number ──────────────────────────────────────────────────────────────

function findInvoiceNumber(lines: string[]): string | null {
  for (const label of INVOICE_NO_LABELS) {
    const re = new RegExp(`${escapeRe(label)}\\s*[:.]?\\s*(?:nr\\.?\\s*)?([A-Za-z0-9][A-Za-z0-9/\\-. ]{0,18})`, 'i');
    for (const line of lines) {
      const m = line.match(re);
      if (m) {
        const value = m[1].trim()
          .replace(/\s+\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}.*$/, '') // drop a trailing date ("554117 11.06.2026")
          .replace(/\s+[a-zäöü]+\.?$/i, '')                        // drop a trailing word ("2026-171 an")
          .replace(/[.,;]$/, '')
          .trim();
        // Reject pure noise (e.g. label followed by a date or empty token).
        if (value && /\d/.test(value) && !/^\d{1,2}\.\d{1,2}\.\d/.test(value)) {
          return value;
        }
      }
    }
  }
  return null;
}

// ─── Dates ────────────────────────────────────────────────────────────────────

function findDate(lines: string[], labels: string[]): string | null {
  // Prefer a date on a line carrying one of the labels. When a line carries the label,
  // read the date that appears AFTER it first — so a compact line holding both
  // "Rechnungsdatum … Fällig …" yields the correct date for each label rather than always
  // returning the first date on the line. Fall back to the whole line if nothing follows.
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const label of labels) {
      const idx = lower.indexOf(label);
      if (idx < 0) continue;
      const d = parseAnyDate(line.slice(idx + label.length)) ?? parseAnyDate(line);
      if (d) return d;
    }
  }
  return null;
}

const NUMERIC_DATE_RE = /\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\b/;
const GERMAN_LONG_DATE_RE = /\b(\d{1,2})\.?\s+([A-Za-zäöü]+)\s+(\d{4})\b/;

function parseAnyDate(text: string): string | null {
  const numeric = text.match(NUMERIC_DATE_RE);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    return toIso(year, month, day);
  }

  const long = text.match(GERMAN_LONG_DATE_RE);
  if (long) {
    const day = Number(long[1]);
    const month = GERMAN_MONTHS[long[2].toLowerCase()];
    const year = Number(long[3]);
    if (month) return toIso(year, month, day);
  }

  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────────

function findLabeledValue(lines: string[], labels: string[]): string | null {
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const label of labels) {
      const idx = lower.indexOf(label);
      if (idx >= 0) {
        const after = line.slice(idx + label.length).replace(/^\s*[:\-]\s*/, '').trim();
        if (after) return after;
      }
    }
  }
  return null;
}

function normalizeName(s: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
