import { VatRate } from "../../../../core/models/domain.models";

/**
 * Extracts all numeric values from a string.
 * Handles European-style decimals: "10,20" → 10.20
 */
export function extractNumbers(text: string): number[] {
  const normalized = text.replace(/(\d),(\d{2})(?!\d)/g, '$1.$2');
  const matches = normalized.match(/\d+(?:\.\d+)?/g) ?? [];
  return matches.map(Number);
}

/**
 * Detects quantity from patterns like:
 * - "x3", "3x", "x 3", "3 x"
 * - "38 P.P. 76"       → qty = 76 / 38 = 2
 * - "10,20€ = 20,40€"  → qty = 20.40 / 10.20 = 2
 * Returns null if not detected (caller defaults to 1).
 */
export function detectQuantity(text: string): number | null {
  // Explicit multiplier: "x3", "3x", "x 3", "3 x"
  const xMatch = text.match(/(\d+)\s*[xX]|[xX]\s*(\d+)/);
  if (xMatch) {
    const val = Number(xMatch[1] ?? xMatch[2]);
    if (val > 1) return val;
  }

  // Per-person: "38 P.P. 76" / "38 per person 76" / "38 per 76"
  const ppMatch = text.match(
    /(\d+(?:[.,]\d+)?)\s*(?:p\.?p\.?|per\s*person|(?<!\w)per(?!\w))\s*(\d+(?:[.,]\d+)?)/i
  );
  if (ppMatch) {
    const unit = parseEuropeanNumber(ppMatch[1]);
    const total = parseEuropeanNumber(ppMatch[2]);
    if (unit > 0) {
      const qty = Math.round(total / unit);
      if (qty >= 2) return qty;
    }
  }

  // Implied multiplier: "10,20€ = 20,40€" → unit€ = total€
  const impliedMatch = text.match(
    /(\d+(?:[.,]\d+)?)\s*[€E]\s*=\s*(\d+(?:[.,]\d+)?)\s*[€E]/i
  );
  if (impliedMatch) {
    const unit = parseEuropeanNumber(impliedMatch[1]);
    const total = parseEuropeanNumber(impliedMatch[2]);
    if (unit > 0 && total > unit) {
      const qty = Math.round(total / unit);
      if (qty >= 2) return qty;
    }
  }

  return null;
}

/**
 * Detects the unit price from patterns like:
 * - "20€ x 2 = 40€"   → 20
 * - "38 P.P. 76€"      → 38
 * - "10,20€ = 20,40€"  → 10.20
 * Falls back to smallest price found (likely the unit price).
 */
export function detectUnitPrice(text: string, quantity: number): number | null {
  // Explicit "unit€ x qty": grab price before the multiplier
  const unitXTotal = text.match(/(\d+(?:[.,]\d+)?)\s*[€E]\s*[xX]\s*\d/i);
  if (unitXTotal) {
    return parseEuropeanNumber(unitXTotal[1]);
  }

  // Per-person "38 P.P. 76": first number is unit price
  const ppMatch = text.match(
    /(\d+(?:[.,]\d+)?)\s*(?:p\.?p\.?|per\s*person|(?<!\w)per(?!\w))\s*(\d+(?:[.,]\d+)?)/i
  );
  if (ppMatch) {
    return parseEuropeanNumber(ppMatch[1]);
  }

  // Implied "unit€ = total€": first price is unit price
  const impliedMatch = text.match(
    /(\d+(?:[.,]\d+)?)\s*[€E]\s*=\s*(\d+(?:[.,]\d+)?)\s*[€E]/i
  );
  if (impliedMatch) {
    return parseEuropeanNumber(impliedMatch[1]);
  }

  // Fallback: collect all prices, return smallest (most likely unit price)
  const normalized = text.replace(/(\d),(\d{2})(?!\d)/g, '$1.$2');
  const allPrices = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*[€E]/gi)]
    .map(m => Number(m[1]));

  if (allPrices.length === 0) return null;
  if (allPrices.length === 1) return allPrices[0];

  return [...allPrices].sort((a, b) => a - b)[0];
}

/**
 * Detects explicit VAT percentage from text.
 * Returns null if none found (caller uses defaultVat).
 */
export function detectVat(text: string): VatRate | null {
  const match = text.match(/(\d+)\s*%/);
  if (!match) return null;

  const val = Number(match[1]);
  const validRates: VatRate[] = [0, 10, 13, 20];
  return validRates.includes(val as VatRate) ? (val as VatRate) : null;
}

/**
 * Cleans a line into a human-readable description.
 * Strips: prices, currencies, quantities, per-person markers, symbols.
 */
export function cleanDescription(text: string): string {
  return text
    .replace(/\d+(?:[.,]\d+)?\s*[€E]/gi, '')              // prices with currency
    .replace(/€/g, '')                                      // remaining € symbols
    .replace(/\b[Ee]\b/g, '')                               // standalone E/e currency
    .replace(/\d+\s*[xX]|[xX]\s*\d+/g, '')                // quantity multipliers
    .replace(/per\s*person|(?<!\w)per(?!\w)/gi, '')         // "per person" / "per"
    .replace(/p\.?p\.?/gi, '')                              // "p.p." / "pp"
    .replace(/=\s*\d+(?:[.,]\d+)?/g, '')                   // "= 40"
    .replace(/\d+(?:[.,]\d+)?/g, '')                       // remaining numbers
    .replace(/[-–—]/g, ' ')                                 // dashes to spaces
    .replace(/[^a-zA-ZÀ-ž\s]/g, ' ')                       // non-alpha to spaces
    .replace(/\s{2,}/g, ' ')                                // collapse whitespace
    .trim();
}

// ── Internal helper ───────────────────────────────────────────────────────────

function parseEuropeanNumber(str: string): number {
  return Number(str.replace(',', '.'));
}