import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserService } from '../src/services/userService';
import type { PreProccessChatMsg } from '../src/services/botService';
import { toUnixSeconds } from '../src/utils/common';

test('WhatsApp timestamps in every stored format become numbers', () => {
  assert.equal(toUnixSeconds(1792140595), 1792140595);
  assert.equal(toUnixSeconds('1792140595'), 1792140595);
  assert.equal(toUnixSeconds({ low: 1789008772, high: 0, unsigned: true }), 1789008772);
  // How the message store saved a Long for 8 messages, which broke sorting the whole chat
  assert.equal(toUnixSeconds('{"low":1789008772,"high":0,"unsigned":true}'), 1789008772);
  assert.equal(toUnixSeconds({ low: -1, high: 0, unsigned: true }), 4294967295);
  assert.equal(toUnixSeconds(undefined), 0);
});

test('messages with JSON text timestamps sort in time order with the rest', () => {
  const stored = ['1782000300', '{"low":1782000100,"high":0,"unsigned":true}', '1782000200', '{"low":1782000000,"high":0}'];
  assert.deepEqual(stored.map(toUnixSeconds).sort((a, b) => a - b), [1782000000, 1782000100, 1782000200, 1782000300]);
});

/** A UserService without a database, with tool call trails after the given message ids. */
function setup(trails: { [msgId: string]: any[] }) {
  const users = Object.create(UserService.prototype) as UserService;
  Object.assign(users, {
    store: { toolCallHist: { trailsFor: async () => new Map(Object.entries(trails).map(([id, items]) => [id, items.map(data => ({ data, createdAt: null }))])) } },
    generateUserStringFromJid: async (jid: string) => jid,
    promptChangelogPath: 'does-not-exist.json',
  });
  return users;
}

const t0 = new Date('2026-10-12T10:00:00+08:00').getTime() / 1000;
const msg = (id: string, user: string, minutes: number, text: string): PreProccessChatMsg => ({ id, user, time: t0 + minutes * 60, text });
const call = (name: string, id: string) => ({ type: 'function_call', call_id: id, name, arguments: '{}' });
const output = (id: string, out: string) => ({ type: 'function_call_output', call_id: id, output: out });
const summarise = (items: any[]) => items.map(i => i.type == 'message' ? `${i.role}: ${(i.content as string).split('\n').slice(-2)[0]}` : `${i.type}${i.output ? ` ${i.output}` : ''}`);

test('the window is the last messages, tool calls do not make it bigger, and old ones are left out', async () => {
  const users = setup({
    a2: [call('memory_write', 'c1'), output('c1', 'saved')], // after a message outside the window
    a4: [{ type: 'reasoning', id: 'r1', summary: [] }, call('schedule_task', 'c2'), output('c2', '{"id":"task1"}')],
  });
  const history = [
    msg('u1', 'azlan', 0, 'hi'), msg('a2', 'AI', 1, 'hello'),
    msg('u3', 'azlan', 2, 'remind me at 11:15'), msg('a4', 'AI', 3, 'done!'),
    msg('u5', 'azlan', 4, 'thanks'),
  ];
  const [window] = await users.formatAndMergeMessages(history, 3);
  // Sofia is told older messages were left out, and from when to read them with `read_chat_history`
  assert.match((window[0] as any).content, /^Only the latest 3 messages .*`read_chat_history` with this chat's ID and `after` set to a time before the earliest message shown \(2026-10-12T10:02:00\+08:00\)\.$/);
  assert.deepEqual(summarise(window.slice(1)), [
    'user: remind me at 11:15',
    'assistant: done!',
    'function_call',
    'function_call_output [Result from around 12/10/2026, Mon (10:03:00), it may be out of date now] {"id":"task1"}',
    'user: thanks',
  ]);
});

test('tool results saved with created_at are stamped with their exact time', async () => {
  const users = setup({});
  (users as any).store.toolCallHist.trailsFor = async () => new Map([['a2', [
    { data: call('list_scheduled_tasks', 'c1'), createdAt: new Date('2026-10-12T10:11:45+08:00') },
    { data: output('c1', '[]'), createdAt: new Date('2026-10-12T10:11:46+08:00') },
  ]]]);
  const [window] = await users.formatAndMergeMessages([msg('u1', 'azlan', 0, 'tasks?'), msg('a2', 'AI', 1, 'checking')], 24);
  assert.equal(window.length, 4, 'nothing left out, so no note');
  assert.equal(window[3].type, 'function_call_output');
  assert.equal((window[3] as any).output, '[Result from 12/10/2026, Mon (10:11:46), it may be out of date now] []');
});
