import { GoogleGenAI } from '@google/genai';

export const SUMMARY_CHAR_LIMIT = 35000;
export const SUMMARY_MODEL = 'gemini-3-flash-preview';
export const SUMMARY_SYSTEM =
  'Je bent een executive summary bot. Geef een vloeiende tekst terug voor snellezen in hoofdletters voor betere focus.';

export function buildSummaryPrompt(text) {
  const clipped = String(text ?? '').slice(0, SUMMARY_CHAR_LIMIT);
  return `Taak: Vat dit document samen voor een snellezer. Focus op kernboodschappen. Gebruik maximaal 600 woorden. Document: ${clipped}`;
}

export async function summarizeWithGemini(text, apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey) {
    const err = new Error('missing_api_key');
    err.status = 503;
    err.public = true;
    throw err;
  }
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: SUMMARY_MODEL,
    contents: buildSummaryPrompt(text),
    config: {
      systemInstruction: SUMMARY_SYSTEM,
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
}
