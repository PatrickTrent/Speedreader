/**
 * Starts at most one checkout at a time.
 * A second call while the first is still running does not call request again.
 * A failure clears the lock so the buyer can try again.
 * Success (the request navigates to Stripe) keeps the lock held.
 * @returns {Promise<boolean>} true when request() reports ok.
 */
export async function runCheckout(lock, options) {
  if (lock.busy) return false;
  lock.busy = true;
  options.setBusy(true);
  try {
    const result = await options.request();
    if (result && result.ok) return true;
    options.setPayError((result && result.message) || options.unavailable);
  } catch (e) {
    console.error(e);
    options.setPayError(options.unavailable);
  }
  lock.busy = false;
  options.setBusy(false);
  return false;
}
