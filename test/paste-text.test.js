import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_TEXT_LIMIT } from '../lib/upload-file.js';
import { SUMMARY_CHAR_LIMIT, SUMMARY_MIN_WORDS, summaryWordCount } from '../lib/summarize.js';
import {
  PASTE_BUTTON_LABEL,
  PASTE_EMPTY_MESSAGE,
  PASTE_FIELD_ID,
  PASTE_FILE_NAME,
  PASTE_LABEL,
  PASTE_PLACEHOLDER,
  SCANNED_PDF_MESSAGE,
  canLoadPastedText,
  exceedsUploadLimit,
  focusPasteField,
  loadPastedText,
  pasteBlockReason,
  pasteLimitMessage,
  readerDocumentState,
} from '../lib/paste-text.js';

function htmlIds(html) {
  return [...String(html).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
}

test('paste copy names the field the scan alert points at', () => {
  assert.equal(PASTE_LABEL, 'Of plak hier je tekst');
  assert.equal(PASTE_BUTTON_LABEL, 'Laad tekst');
  assert.equal(PASTE_PLACEHOLDER, 'Plak hier de tekst die je wilt snellezen...');
  assert.equal(PASTE_EMPTY_MESSAGE, 'Plak eerst tekst.');
  assert.equal(PASTE_FIELD_ID, 'paste-text');
  assert.match(SCANNED_PDF_MESSAGE, /Plak de tekst/);
  assert.ok(SCANNED_PDF_MESSAGE.includes(PASTE_LABEL));
  assert.ok(SCANNED_PDF_MESSAGE.includes('geen tekstlaag'));
  assert.equal(SCANNED_PDF_MESSAGE.includes(PASTE_FIELD_ID), false);
});

test('blank paste is refused and whitespace gets the empty reason', () => {
  for (const value of ['', '   ', '\n\t', ' \n ', null, undefined]) {
    assert.equal(pasteBlockReason(value), 'empty');
    assert.equal(canLoadPastedText(value), false);
    const loaded = loadPastedText(value);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, 'empty');
    assert.equal(loaded.message, PASTE_EMPTY_MESSAGE);
  }
  assert.equal(pasteBlockReason('een zin'), '');
  assert.equal(canLoadPastedText('een zin'), true);
});

test('pasted text loads the same reader state as an uploaded file', () => {
  const source = '  Hallo   wereld. Dit is een zin. ';
  const fromFile = readerDocumentState(source, 'brief.docx');
  const fromPaste = loadPastedText(source);
  assert.equal(fromPaste.ok, true);
  assert.equal(fromPaste.state.rawText, fromFile.rawText);
  assert.equal(fromPaste.state.rawText, source);
  assert.equal(fromPaste.state.text, fromFile.text);
  assert.equal(fromPaste.state.text, source.toUpperCase());
  assert.deepEqual(fromPaste.state.words, fromFile.words);
  assert.deepEqual(fromPaste.state.words, source.toUpperCase().trim().split(/\s+/));
  assert.equal(fromPaste.state.currentIndex, 0);
  assert.equal(fromPaste.state.currentIndex, fromFile.currentIndex);
  assert.equal(fromPaste.state.isPlaying, false);
  assert.equal(fromPaste.state.isPlaying, fromFile.isPlaying);
  assert.equal(fromPaste.state.fileName, PASTE_FILE_NAME);
  assert.equal(fromFile.fileName, 'brief.docx');
});

test('the 150-word summary rule sees the same raw text a file would load', () => {
  const short = loadPastedText('een twee drie');
  assert.equal(short.ok, true);
  const shortCount = summaryWordCount(short.state.rawText.slice(0, SUMMARY_CHAR_LIMIT));
  assert.ok(shortCount < SUMMARY_MIN_WORDS);

  const words = Array.from({ length: SUMMARY_MIN_WORDS }, (_, i) => `woord${i}`);
  const long = loadPastedText(words.join(' '));
  assert.equal(long.ok, true);
  const longCount = summaryWordCount(long.state.rawText.slice(0, SUMMARY_CHAR_LIMIT));
  assert.equal(longCount, SUMMARY_MIN_WORDS);
  assert.equal(long.state.words.length, SUMMARY_MIN_WORDS);
  assert.equal(long.state.text, long.state.rawText.toUpperCase());
});

test('paste keeps the full text because file upload has no character cap', () => {
  assert.equal(UPLOAD_TEXT_LIMIT, null);
  assert.equal(exceedsUploadLimit('x'.repeat(100000)), false);
  assert.equal(exceedsUploadLimit('abcd', 3), true);
  assert.equal(exceedsUploadLimit('abc', 3), false);
  assert.equal(exceedsUploadLimit('abcd', null), false);
  assert.equal(pasteLimitMessage(512), 'Deze tekst is langer dan 512 tekens.');
  const source = `${'woord '.repeat(40000)}einde`;
  const loaded = loadPastedText(source);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.rawText, source);
  assert.ok(loaded.state.rawText.length > SUMMARY_CHAR_LIMIT);
});

test('a configured upload limit blocks paste past that length', () => {
  const text = 'woord '.repeat(20);
  assert.equal(pasteBlockReason(text, 10), 'limit');
  assert.equal(canLoadPastedText(text, 10), false);
  const blocked = loadPastedText(text, 10);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'limit');
  assert.equal(blocked.message, pasteLimitMessage(10));
  const kept = loadPastedText(text, text.length);
  assert.equal(kept.ok, true);
  assert.equal(kept.state.rawText, text);
});

test('focusPasteField scrolls the paste field into view and focuses it', () => {
  const calls = [];
  const el = {
    scrollIntoView(options) { calls.push(['scroll', options]); },
    focus(options) { calls.push(['focus', options]); },
  };
  const doc = {
    getElementById(id) {
      return id === PASTE_FIELD_ID ? el : null;
    },
  };
  assert.equal(focusPasteField(doc), true);
  assert.deepEqual(calls[0], ['scroll', { block: 'center', inline: 'nearest' }]);
  assert.equal(calls[1][0], 'focus');
  assert.equal(calls[1][1].preventScroll, true);
  assert.equal(focusPasteField({ getElementById() { return null; } }), false);
  assert.equal(focusPasteField(undefined), false);
});

test('focus still moves when focus options are not supported', () => {
  const calls = [];
  const el = {
    scrollIntoView() { calls.push('scroll'); },
    focus(options) {
      if (options) throw new Error('unsupported');
      calls.push('focus');
    },
  };
  assert.equal(focusPasteField({ getElementById() { return el; } }), true);
  assert.deepEqual(calls, ['scroll', 'focus']);
});

test('the app wires paste into the same reader load as a file and keeps #upload unique', () => {
  const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8');
  const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
  const lib = fs.readFileSync(path.resolve('lib/paste-text.js'), 'utf8');

  assert.equal((app.match(/id="upload"/g) || []).length, 1);
  assert.equal((html.match(/id="upload"/g) || []).length, 1);
  assert.match(html, /querySelector\('#home-start-static #upload'\)/);
  assert.match(html, /staticUpload\.removeAttribute\('id'\)/);
  assert.equal(html.includes(PASTE_FIELD_ID), false);
  assert.equal(app.includes('id="paste-text"'), false);
  assert.equal((app.match(/id=\{PASTE_FIELD_ID\}/g) || []).length, 1);
  assert.equal((app.match(/htmlFor=\{PASTE_FIELD_ID\}/g) || []).length, 1);
  assert.equal((app.match(/id="paste-text-hint"/g) || []).length, 1);

  const seen = new Set();
  for (const id of htmlIds(app)) {
    assert.equal(seen.has(id), false, `duplicate id ${id}`);
    seen.add(id);
  }

  assert.ok(app.includes('aria-label={PASTE_LABEL}'));
  assert.ok(app.includes('placeholder={PASTE_PLACEHOLDER}'));
  assert.ok(app.includes('{PASTE_LABEL}'));
  assert.ok(app.includes('{PASTE_BUTTON_LABEL}'));
  assert.ok(app.includes('maxLength={UPLOAD_TEXT_LIMIT ?? undefined}'));
  assert.ok(app.includes('disabled={pasteBlock !== \'\'}'));
  assert.ok(app.includes('accept=".pdf,.docx"'));
  assert.equal((app.match(/<textarea/g) || []).length, 1);
  assert.equal((app.match(/type="file"/g) || []).length, 1);

  assert.match(app, /applyReaderDocument\(extractedText, file\.name\)/);
  assert.match(app, /applyReaderDocument\(loaded\.state\.rawText, loaded\.state\.fileName\)/);
  assert.match(app, /const next = readerDocumentState\(sourceText, name\)/);
  assert.ok(app.includes('fileName === PASTE_FILE_NAME'));

  const scan = app.slice(
    app.indexOf('if (!hasTextLayer(extractedText))'),
    app.indexOf("} else if (kind === 'docx')"),
  );
  assert.match(scan, /alert\(SCANNED_PDF_MESSAGE\)/);
  assert.match(scan, /focusPasteField\(\)/);
  assert.ok(scan.indexOf('alert(SCANNED_PDF_MESSAGE)') < scan.indexOf('focusPasteField()'));
  assert.equal(app.includes('Deze PDF heeft geen tekstlaag'), false);
  assert.ok(lib.includes('Plak de tekst in het veld'));
  assert.ok(lib.includes('${PASTE_LABEL}'));
});
