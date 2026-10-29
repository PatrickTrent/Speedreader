/** Scroll to location.hash. The browser looks before React mounts #upload, #faq, and #reader. */
export function scrollToLocationHash(win = globalThis) {
  const hash = String(win.location?.hash || '');
  if (hash.length < 2) return () => {};
  let id = hash.slice(1);
  try { id = decodeURIComponent(id); } catch { /* keep the raw id */ }

  let cancelled = false;
  const stops = [];
  const attempt = () => {
    if (cancelled) return true;
    const el = win.document.getElementById(id);
    if (!el || typeof el.scrollIntoView !== 'function') return false;
    el.scrollIntoView({ block: 'start' });
    return true;
  };
  const frame = (fn) => {
    if (typeof win.requestAnimationFrame === 'function') {
      const handle = win.requestAnimationFrame(fn);
      stops.push(() => win.cancelAnimationFrame?.(handle));
      return;
    }
    const handle = win.setTimeout(fn, 0);
    stops.push(() => win.clearTimeout(handle));
  };
  const later = (fn) => {
    const handle = win.setTimeout(fn, 50);
    stops.push(() => win.clearTimeout(handle));
  };

  if (!attempt()) {
    frame(() => {
      if (attempt()) return;
      frame(() => {
        if (!attempt()) later(attempt);
      });
    });
  }
  return () => {
    cancelled = true;
    for (const stop of stops) stop();
  };
}
