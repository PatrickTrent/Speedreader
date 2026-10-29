import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scrollToLocationHash } from '../lib/hash-scroll.js';

function fakeWindow(hash) {
  const frames = [];
  const timeouts = [];
  const scrolled = [];
  let present = null;
  const win = {
    location: { hash },
    document: {
      getElementById(id) {
        return present && present.id === id ? present : null;
      },
    },
    requestAnimationFrame(cb) {
      frames.push(cb);
      return frames.length;
    },
    cancelAnimationFrame() {},
    setTimeout(cb, ms) {
      timeouts.push({ cb, ms });
      return timeouts.length;
    },
    clearTimeout() {},
  };
  return {
    win,
    frames,
    timeouts,
    scrolled,
    mount(id) {
      present = {
        id,
        scrollIntoView() { scrolled.push(id); },
      };
    },
  };
}

test('an empty hash does not scroll', () => {
  const env = fakeWindow('');
  env.mount('upload');
  scrollToLocationHash(env.win);
  assert.deepEqual(env.scrolled, []);
  assert.equal(env.frames.length, 0);
});

test('scrolls immediately when the hash target is already mounted', () => {
  for (const id of ['upload', 'faq', 'reader']) {
    const env = fakeWindow(`#${id}`);
    env.mount(id);
    scrollToLocationHash(env.win);
    assert.deepEqual(env.scrolled, [id]);
    assert.equal(env.frames.length, 0);
  }
});

test('waits a frame when the hash target appears after render', () => {
  const env = fakeWindow('#upload');
  scrollToLocationHash(env.win);
  assert.deepEqual(env.scrolled, []);
  assert.equal(env.frames.length, 1);
  env.mount('upload');
  env.frames.shift()();
  assert.deepEqual(env.scrolled, ['upload']);
  assert.equal(env.timeouts.length, 0);
});

test('waits 50ms when the hash target is still missing after two frames', () => {
  const env = fakeWindow('#faq');
  scrollToLocationHash(env.win);
  env.frames.shift()();
  env.frames.shift()();
  assert.deepEqual(env.scrolled, []);
  assert.equal(env.timeouts.length, 1);
  assert.equal(env.timeouts[0].ms, 50);
  env.mount('faq');
  env.timeouts[0].cb();
  assert.deepEqual(env.scrolled, ['faq']);
});

test('the app scrolls to the hash after mount and on hashchange', () => {
  const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8');
  assert.ok(app.includes('scrollToLocationHash(window)'));
  assert.ok(app.includes("addEventListener('hashchange'"));
  assert.ok(app.includes('id="upload"'));
  assert.ok(app.includes('id="faq"'));
  assert.ok(app.includes('id="reader"'));
});
