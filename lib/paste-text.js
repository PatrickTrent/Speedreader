import { UPLOAD_TEXT_LIMIT } from './upload-file.js';

export { UPLOAD_TEXT_LIMIT };

/** Visible label, aria-label, and the name the scan alert uses for this field. */
export const PASTE_LABEL = 'Of plak hier je tekst';
export const PASTE_BUTTON_LABEL = 'Laad tekst';
export const PASTE_PLACEHOLDER = 'Plak hier de tekst die je wilt snellezen...';
export const PASTE_EMPTY_MESSAGE = 'Plak eerst tekst.';
export const PASTE_FIELD_ID = 'paste-text';
export const PASTE_FILE_NAME = 'Gekopieerde Tekst';

export const SCANNED_PDF_MESSAGE =
  `Deze PDF heeft geen tekstlaag (waarschijnlijk een scan). Plak de tekst in het veld "${PASTE_LABEL}", of gebruik een PDF waarvan je de tekst kunt selecteren.`;

/** Reader fields set for an uploaded file and for pasted text. */
export function readerDocumentState(sourceText, fileName) {
  const rawText = String(sourceText ?? '');
  const text = rawText.toUpperCase();
  return {
    fileName: String(fileName ?? ''),
    rawText,
    text,
    words: text.trim().split(/\s+/),
    currentIndex: 0,
    isPlaying: false,
  };
}

export function exceedsUploadLimit(text, limit = UPLOAD_TEXT_LIMIT) {
  if (limit == null) return false;
  return String(text ?? '').length > limit;
}

export function pasteLimitMessage(limit = UPLOAD_TEXT_LIMIT) {
  return `Deze tekst is langer dan ${limit} tekens.`;
}

/** '' when the paste can be loaded, otherwise 'empty' or 'limit'. */
export function pasteBlockReason(value, limit = UPLOAD_TEXT_LIMIT) {
  const text = String(value ?? '');
  if (!text.trim()) return 'empty';
  if (exceedsUploadLimit(text, limit)) return 'limit';
  return '';
}

export function canLoadPastedText(value, limit = UPLOAD_TEXT_LIMIT) {
  return pasteBlockReason(value, limit) === '';
}

export function loadPastedText(value, limit = UPLOAD_TEXT_LIMIT) {
  const reason = pasteBlockReason(value, limit);
  if (reason === 'empty') return { ok: false, reason, message: PASTE_EMPTY_MESSAGE };
  if (reason === 'limit') return { ok: false, reason, message: pasteLimitMessage(limit) };
  return { ok: true, state: readerDocumentState(value, PASTE_FILE_NAME) };
}

/** Scroll the paste field into view and move focus there. Returns false if it is not mounted. */
export function focusPasteField(doc = globalThis.document) {
  if (!doc || typeof doc.getElementById !== 'function') return false;
  const el = doc.getElementById(PASTE_FIELD_ID);
  if (!el) return false;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  if (typeof el.focus === 'function') {
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }
  return true;
}
