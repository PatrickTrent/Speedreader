/**
 * Legal colophon. The VAT id is confirmed. Add the chamber-of-commerce
 * number on COMPANY_LINE only after it is confirmed, so every page picks it up.
 */
export const COMPANY_LINE = 'Trentelman AI Solutions, btw NL004908763B50';
export const COMPANY_PLACE = 'Groningen';

export function applyCompanyMarkup(html) {
  return String(html)
    .replaceAll('{{COMPANY_LINE}}', COMPANY_LINE)
    .replaceAll('{{COMPANY_PLACE}}', COMPANY_PLACE);
}
