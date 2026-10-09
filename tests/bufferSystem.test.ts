import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { BufferSystem } from '../src/services/bufferSystem';

// Scaled down timings: 3s delay -> 150ms, 15s typing timeout -> 600ms, 30s max wait -> 1200ms
const OPTIONS = { delayMs: 150, typingTimeoutMs: 600, maxWaitMs: 1200 };
const GROUP = '123@g.us';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function setup() {
  const buffer = new BufferSystem(pino({ level: 'silent' }), OPTIONS);
  const runs: { label: string, at: number }[] = [];
  const start = Date.now();
  const call = (label: string, durationMs = 0) => buffer.bufferCall(GROUP, async () => {
    runs.push({ label, at: Date.now() - start });
    await sleep(durationMs);
  });
  return { buffer, runs, call, start };
}

test('waits at least the delay after a single message', async () => {
  const { runs, call } = setup();
  call('m1');
  await sleep(100);
  assert.equal(runs.length, 0);
  await sleep(100);
  assert.deepEqual(runs.map(r => r.label), ['m1']);
  assert.ok(runs[0].at >= OPTIONS.delayMs);
});

test('a new message restarts the minimum delay and only the latest call runs', async () => {
  const { runs, call } = setup();
  call('m1');
  await sleep(100);
  call('m2');
  await sleep(100); // 200ms after m1, but only 100ms after m2
  assert.equal(runs.length, 0);
  await sleep(100);
  assert.deepEqual(runs.map(r => r.label), ['m2']);
  assert.ok(runs[0].at >= 100 + OPTIONS.delayMs);
});

test('group: keeps waiting while any participant is still typing', async () => {
  const { buffer, runs, call } = setup();
  call('m1');
  buffer.setTyping(GROUP, 'alice', true);
  buffer.setTyping(GROUP, 'bob', true);
  await sleep(50);
  // Previously, bob's update alone resumed the buffer even though alice was typing
  buffer.setTyping(GROUP, 'bob', false);
  await sleep(250);
  assert.equal(runs.length, 0, 'should still wait for alice');
  buffer.setTyping(GROUP, 'alice', false);
  await sleep(50);
  assert.equal(runs.length, 1);
});

test('group: typing that never stops expires instead of blocking forever', async () => {
  const { buffer, runs, call } = setup();
  call('m1');
  buffer.setTyping(GROUP, 'alice', true); // no 'paused' ever arrives
  await sleep(450);
  assert.equal(runs.length, 0);
  await sleep(300);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].at >= OPTIONS.typingTimeoutMs - 20);
});

test('group: constant typing cannot delay a reply past the max wait', async () => {
  const { buffer, runs, call } = setup();
  call('m1');
  const refresher = setInterval(() => buffer.setTyping(GROUP, 'chatty', true), 100);
  await sleep(1100);
  assert.equal(runs.length, 0);
  await sleep(250);
  clearInterval(refresher);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].at >= OPTIONS.maxWaitMs - 20 && runs[0].at < OPTIONS.maxWaitMs + 150);
});

test('max wait never skips the minimum delay after the latest message', async () => {
  const { buffer, runs, call } = setup();
  call('m1');
  const refresher = setInterval(() => buffer.setTyping(GROUP, 'chatty', true), 100);
  await sleep(1150);
  call('m2'); // just before the max wait deadline
  await sleep(100);
  assert.equal(runs.length, 0, 'must still wait the minimum delay after m2');
  await sleep(150);
  clearInterval(refresher);
  assert.deepEqual(runs.map(r => r.label), ['m2']);
});

test('messages while a reply is running are handled once after it finishes', async () => {
  const { runs, call } = setup();
  call('m1', 300);
  await sleep(200); // m1 running
  call('m2');
  call('m3');
  await sleep(250); // m1 finishes at ~450ms
  assert.deepEqual(runs.map(r => r.label), ['m1']);
  await sleep(200);
  assert.deepEqual(runs.map(r => r.label), ['m1', 'm3']);
  assert.ok(runs[1].at >= 450 + OPTIONS.delayMs - 20);
  await sleep(300);
  assert.equal(runs.length, 2);
});

test('someone already typing when a message arrives delays the reply', async () => {
  const { buffer, runs, call } = setup();
  buffer.setTyping(GROUP, 'alice', true);
  call('m1');
  await sleep(300);
  assert.equal(runs.length, 0);
  buffer.setTyping(GROUP, 'alice', false);
  await sleep(50);
  assert.equal(runs.length, 1);
});

test('a failing call does not leave the buffer stuck', async () => {
  const { buffer, runs } = setup();
  buffer.bufferCall(GROUP, async () => { throw Error('boom'); });
  await sleep(200);
  assert.equal(buffer.chatBuffers[GROUP], undefined);
  buffer.bufferCall(GROUP, async () => { runs.push({ label: 'after', at: 0 }); });
  await sleep(200);
  assert.equal(runs.length, 1);
});
