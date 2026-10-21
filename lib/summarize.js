export const SUMMARY_CHAR_LIMIT = 35000;
export const SUMMARY_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const SUMMARY_SYSTEM =
  'Je bent een executive summary bot. Geef een vloeiende tekst terug voor snellezen in hoofdletters voor betere focus.';

export function buildSummaryPrompt(text) {
  const clipped = String(text ?? '').slice(0, SUMMARY_CHAR_LIMIT);
  return `Taak: Vat dit document samen voor een snellezer. Focus op kernboodschappen. Gebruik maximaal 600 woorden. Document: ${clipped}`;
}

export const SUMMARY_TIMEOUT_MS = 60_000;
export const SUMMARY_UNAVAILABLE = 'Summaries are temporarily unavailable';

export async function summarizeWithOpenRouter(text, apiKey = process.env.OPENROUTER_API_KEY, options = {}) {
  if (!apiKey) {
    const err = new Error('summaries_unavailable');
    err.status = 503;
    err.public = true;
    throw err;
  }
  const timeoutMs = options.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await (options.fetch || fetch)(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://speedreader.nl',
        'X-Title': 'Speedreader',
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: buildSummaryPrompt(text) },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`openrouter_${res.status}`);
      err.status = 502;
      throw err;
    }
    const response = { text: data?.choices?.[0]?.message?.content || '' };
    const summary = (response.text || '').toUpperCase();
    if (!summary.trim()) {
      const err = new Error('empty_summary');
      err.status = 502;
      err.public = true;
      throw err;
    }
    return summary;
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutErr = new Error('summary_timeout');
      timeoutErr.status = 504;
      timeoutErr.public = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onParentAbort);
  }
}

/** @deprecated name kept for older imports */
export const summarizeWithGemini = summarizeWithOpenRouter;
