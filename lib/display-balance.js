/** Balance shown in the reader. A failed wallet read is unknown, not zero. */
export function displayBalance(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.exists && typeof data.balance === 'number') return data.balance;
  if (data.freeEligible) return 2;
  return typeof data.balance === 'number' ? data.balance : null;
}

/** Open the paywall only when the balance is known and empty. */
export function openPaywallBeforeSummarize(credits) {
  return credits !== null && credits <= 0;
}
