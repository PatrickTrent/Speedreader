import test from 'node:test';
import assert from 'node:assert/strict';
import { documentKind, hasTextLayer } from '../lib/upload-file.js';

test('document kind ignores extension case', () => {
  assert.equal(documentKind('hoofdstuk.pdf'), 'pdf');
  assert.equal(documentKind('Hoofdstuk.PDF'), 'pdf');
  assert.equal(documentKind('verslag.Docx'), 'docx');
  assert.equal(documentKind('verslag.DOCX'), 'docx');
  assert.equal(documentKind('notities.txt'), '');
  assert.equal(documentKind(''), '');
  assert.equal(documentKind('pdf'), '');
  assert.equal(documentKind('scan.pdf.docx'), 'docx');
});

test('a scanned PDF has no text layer', () => {
  assert.equal(hasTextLayer(''), false);
  assert.equal(hasTextLayer('   \n\t'), false);
  assert.equal(hasTextLayer(null), false);
  assert.equal(hasTextLayer('Een zin uit de PDF.'), true);
});
