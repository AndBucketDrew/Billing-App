// Shared display formatting helpers.
//
// These are the single source of truth for currency/date formatting across
// the app. Components used to each re-implement the same `Intl.NumberFormat`
// call; they now delegate here. Accepts either an app language code ('de'/'en')
// or a full locale tag ('de-DE'/'en-US') so existing callers keep working.

/** Maps an app language code or locale tag to an Intl locale tag. */
export function localeFor(lang: string | null | undefined): string {
  return lang?.toLowerCase().startsWith('de') ? 'de-DE' : 'en-US';
}

/** Formats a number as EUR currency in the given language's locale. */
export function formatCurrencyEUR(value: number, lang: string | null | undefined = 'de'): string {
  return new Intl.NumberFormat(localeFor(lang), {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Formats a parseable date string as a localized dd.mm.yyyy-style date. */
export function formatDateLocalized(dateString: string, lang: string | null | undefined = 'de'): string {
  return new Date(dateString).toLocaleDateString(localeFor(lang), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
