/** Legal colophon. Change the chamber-of-commerce number only on this line. */
export const COMPANY_KVK = '91686210';
export const COMPANY_LINE = `Trentelman AI Solutions, KvK ${COMPANY_KVK}, btw NL004908763B50, Groningen`;

export function applyCompanyMarkup(html) {
  return String(html).replaceAll('{{COMPANY_LINE}}', COMPANY_LINE);
}
