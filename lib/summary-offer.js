/** Copy shown above the pack buttons. The euro amount is the amount charged. */
export const STARTER_PURCHASE_LINE = '5 credits voor €0,99 incl. btw: 5 AI-samenvattingen. Eenmalig, geen abonnement. Betaal met iDEAL of kaart.';
export const PRO_PURCHASE_LINE = '50 credits voor €3,99 incl. btw: 50 AI-samenvattingen. Eenmalig, geen abonnement. Betaal met iDEAL of kaart.';

/** Factual line under a summary when 0 or 1 credit remains. No scarcity wording. */
export const LOW_BALANCE_OFFER = 'Nog 5 samenvattingen voor €0,99 (incl. btw, eenmalig, iDEAL of kaart)';
export const LOW_BALANCE_BUTTON = 'Koop 5 credits';

/**
 * Which follow-up to show under a finished summary.
 * `low` is 0 or 1 credit (for example after the free credits).
 * `quiet` is a known balance of 2 or more.
 * `none` is an unknown balance.
 */
export function summaryOfferKind(credits) {
  if (credits === 0 || credits === 1) return 'low';
  if (typeof credits === 'number' && Number.isFinite(credits) && credits >= 2) return 'quiet';
  return 'none';
}

/** Remaining credits, without a buy button. */
export function quietCreditLine(credits) {
  const n = Math.max(0, Math.floor(Number(credits)));
  if (n === 1) return 'Nog 1 credit.';
  return `Nog ${n} credits.`;
}
