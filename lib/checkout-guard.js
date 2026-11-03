/** How long a successful checkout may keep the buttons disabled if the page never leaves. */
export const CHECKOUT_NAV_TIMEOUT_MS = 10_000;

/**
 * Clears a held checkout so the buy buttons can be used again.
 * Used when the buyer returns from Stripe, and when navigation does not happen.
 */
export function releaseCheckoutLock(lock, setBusy) {
  if (lock.timer != null) {
    clearTimeout(lock.timer);
    lock.timer = null;
  }
  lock.busy = false;
  lock.redirecting = false;
  setBusy(false);
}

/**
 * Frees the lock when Chrome restores the page from the back/forward cache,
 * and when the tab becomes visible again after a redirect was started.
 */
export function bindCheckoutReturn(lock, setBusy, target = globalThis) {
  const release = () => releaseCheckoutLock(lock, setBusy);
  const onPageShow = (event) => {
    if (event && event.persisted) release();
  };
  const doc = target.document;
  const onVisibility = () => {
    if (lock.redirecting && doc && doc.visibilityState === 'visible') release();
  };
  target.addEventListener('pageshow', onPageShow);
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    target.removeEventListener('pageshow', onPageShow);
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

function armNavTimeout(lock, setBusy, options) {
  const wait = options.navTimeoutMs ?? CHECKOUT_NAV_TIMEOUT_MS;
  const schedule = options.scheduleTimeout || ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  });
  lock.timer = schedule(() => {
    releaseCheckoutLock(lock, setBusy);
  }, wait);
}

/**
 * Starts at most one checkout at a time.
 * A second call while the first is still running does not call request again.
 * A failure clears the lock so the buyer can try again.
 * A Stripe URL keeps the lock until the page is restored, becomes visible again,
 * or the navigation timeout elapses without leaving.
 * @returns {Promise<boolean>} true when request() reports ok.
 */
export async function runCheckout(lock, options) {
  if (lock.busy) return false;
  lock.busy = true;
  lock.redirecting = false;
  options.setBusy(true);
  try {
    const result = await options.request();
    if (result && result.ok) {
      lock.redirecting = true;
      armNavTimeout(lock, options.setBusy, options);
      return true;
    }
    options.setPayError((result && result.message) || options.unavailable);
  } catch (e) {
    console.error(e);
    options.setPayError(options.unavailable);
  }
  releaseCheckoutLock(lock, options.setBusy);
  return false;
}
