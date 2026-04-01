import { VatRate } from '../../../../core/models/domain.models';
import { ParsedLineItem, ParseResult } from '../../../../core/models/line-item-parser/line-item-parser.types';
import {
  detectQuantity,
  detectUnitPrice,
  detectVat,
  cleanDescription,
} from './line-item-helpers';

const SKIP_PATTERNS = [
  /^\s*$/,                    // empty line
  /total/i,                   // lines with "Total"
  /^[a-zA-Z\s]+:$/,           // section headers like "Guiding Services:"
];

function shouldSkipLine(line: string): string | null {
  if (SKIP_PATTERNS[0].test(line)) return 'empty line';
  if (SKIP_PATTERNS[1].test(line)) return 'contains "Total"';
  if (SKIP_PATTERNS[2].test(line)) return 'section header';
  return null;
}

export function parseTextToLineItems(
  text: string,
  defaultVat: VatRate
): ParseResult {
  const lines = text.split('\n');
  const items: ParsedLineItem[] = [];
  const skipped: { line: string; reason: string }[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // --- Skip check ---
    const skipReason = shouldSkipLine(line);
    if (skipReason) {
      if (line.length > 0) skipped.push({ line, reason: skipReason });
      continue;
    }

    // Flag lines starting with a bare number (ambiguous: could be qty or part of description)
    const startsWithNumber = /^\d+\s+[a-zA-Z]/.test(line);
    const hasExplicitMultiplier = /\d+\s*[xX]|[xX]\s*\d+|p\.?p\.?|per\s*person|(?<!\w)per(?!\w)/i.test(line);

    if (startsWithNumber && !hasExplicitMultiplier) {
      skipped.push({ line, reason: 'starts with number — verify quantity vs. description' });
      continue;
    }

    try {
      const quantity = detectQuantity(line) ?? 1;
      const unitPriceNet = detectUnitPrice(line, quantity);
      const description = cleanDescription(line);
      const vatPercentage = detectVat(line) ?? defaultVat;

      // Skip if we couldn't get a price or description
      if (unitPriceNet === null || unitPriceNet <= 0) {
        skipped.push({ line, reason: 'could not detect price' });
        continue;
      }
      if (!description) {
        skipped.push({ line, reason: 'could not extract description' });
        continue;
      }

      items.push({ description, quantity, unitPriceNet, vatPercentage });
    } catch {
      skipped.push({ line, reason: 'unexpected parse error' });
    }
  }

  return { items, skipped };
}