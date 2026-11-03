/**
 * Uploaded files are read in the browser and are not cut to a character cap.
 * Pasted text uses this same limit: null means the full text is loaded.
 */
export const UPLOAD_TEXT_LIMIT = null;

/** Upload kind for the reader. Extensions are matched case-insensitively. */
export function documentKind(fileName) {
  const name = String(fileName || '').trim().toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  return '';
}

/** A scanned PDF has pages but no extractable text layer. */
export function hasTextLayer(text) {
  return String(text ?? '').trim().length > 0;
}
