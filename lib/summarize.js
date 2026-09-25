import { GoogleGenAI } from '@google/genai';

export const SUMMARY_CHAR_LIMIT = 35000;
export const SUMMARY_MODEL = 'gemini-3-flash-preview';
export const SUMMARY_SYSTEM =
  'Je bent een executive summary bot. Geef een vloeiende tekst terug voor snellezen in hoofdletters voor betere focus.';

export function buildSummaryPrompt(text) {
  const clipped = String(text ?? '').slice(0, SUMMARY_CHAR_LIMIT);
  return `Taak: Vat dit document samen voor een snellezer. Focus op kernboodschappen. Gebruik maximaal 600 woorden. Document: ${clipped}`;
}

export const SUMMARY_TIMEOUT_MS = 60_000;
export const SUMMARY_UNAVAILABLE = 'Summaries are temporarily unavailable';

export async function summarizeWithGemini(text, apiKey = process.env.GEMINI_API_KEY, options = {}) {
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
    const ai = new GoogleGenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
    const response = await ai.models.generateContent({
      model: SUMMARY_MODEL,
      contents: buildSummaryPrompt(text),
      config: {
        systemInstruction: SUMMARY_SYSTEM,
        abortSignal: controller.signal,
      },
    });
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
