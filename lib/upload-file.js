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
