export const SUMMARY_CHAR_LIMIT = 35000;
export const SUMMARY_MIN_WORDS = 150;
export const SUMMARY_MAX_WORDS = 600;
export const SUMMARY_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const SUMMARY_TOO_SHORT = `Deze tekst is te kort voor een samenvatting. Gebruik minstens ${SUMMARY_MIN_WORDS} woorden.`;
export const SUMMARY_RULES =
  'Gebruik alleen feiten uit de bron. Verzin geen nieuwe feiten, meningen of bijvoeglijke naamwoorden zoals innovatief. Schrijf platte tekst zonder markdown: geen **, geen # en geen opsommingstekens. De samenvatting is nooit langer dan de bron, ongeveer hooguit een derde van de bronlengte, en maximaal 600 woorden.';
export const SUMMARY_SYSTEM =
  `Je bent een executive summary bot. Geef een vloeiende tekst terug voor snellezen. ${SUMMARY_RULES} Antwoord in het Nederlands.`;

export function summaryWordCount(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function summaryWordBudget(text) {
  const words = summaryWordCount(String(text ?? '').slice(0, SUMMARY_CHAR_LIMIT));
  if (!words) return 0;
  const third = Math.max(1, Math.floor(words / 3));
  return Math.min(SUMMARY_MAX_WORDS, words, third);
}

export function buildSummaryPrompt(text) {
  const clipped = String(text ?? '').slice(0, SUMMARY_CHAR_LIMIT);
  const budget = summaryWordBudget(clipped);
  const budgetLabel = budget === 1 ? '1 woord' : `${budget} woorden`;
  return `Taak: Vat dit document samen voor een snellezer. Focus op kernboodschappen. ${SUMMARY_RULES} Gebruik hooguit ${budgetLabel}. Antwoord in het Nederlands. Document: ${clipped}`;
}

export function stripSummaryMarkdown(text) {
  return String(text ?? '')
    .replace(/\*\*|__/g, '')
    .split('\n')
    .map((line) => line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^\s*[-*+•]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, ''))
    .join('\n');
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
    const summary = stripSummaryMarkdown(response.text || '');
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
