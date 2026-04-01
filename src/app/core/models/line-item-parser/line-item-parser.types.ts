import { VatRate } from '../domain.models';

export interface ParsedLineItem {
  description: string;
  quantity: number;
  unitPriceNet: number;
  vatPercentage: VatRate;
}

export interface ParseResult {
  items: ParsedLineItem[];
  skipped: { line: string; reason: string }[];
}