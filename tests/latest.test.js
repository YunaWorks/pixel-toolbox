'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const takeLatest = require('../js/latest.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('choosing two files quickly: the second one stays, even if the first decodes last', async () => {
  const pending = {};
  const decode = takeLatest((name) => {
    pending[name] = deferred();
    return pending[name].promise;
  });
  let shown = null;
  // Same steps as the page: decode, then show the image unless a newer file was chosen.
  async function open(name) {
    const result = await decode(name);
    if (!result.stale) shown = result.value;
  }

  const first = open('big-first.png');
  const second = open('small-second.png');
  pending['small-second.png'].resolve('second image');
  await second;
  assert.equal(shown, 'second image');

  pending['big-first.png'].resolve('first image'); // the older, slower file finishes last
  await first;
  assert.equal(shown, 'second image', 'the older file must not replace the newer one');
});

test('a newer call that finishes first marks the older one as stale', async () => {
  const gates = [deferred(), deferred()];
  let n = 0;
  const run = takeLatest(() => gates[n++].promise);
  const a = run();
  const b = run();
  gates[1].resolve('B');
  gates[0].resolve('A');
  assert.deepEqual(await b, { stale: false, value: 'B' });
  assert.deepEqual(await a, { stale: true });
});

test('errors: an outdated call is dropped silently, the latest call reports its error', async () => {
  const gates = [deferred(), deferred()];
  let n = 0;
  const run = takeLatest(() => gates[n++].promise);
  const a = run();
  const b = run();
  gates[0].reject(new Error('old file is broken'));
  gates[1].reject(new Error('new file is broken'));
  assert.deepEqual(await a, { stale: true });
  await assert.rejects(b, /new file is broken/);
});

test('arguments and this are passed through; a single call is never stale', async () => {
  const run = takeLatest(async function (x, y) { return [this.k, x + y]; });
  assert.deepEqual(await run.call({ k: 'ctx' }, 2, 3), { stale: false, value: ['ctx', 5] });
});
