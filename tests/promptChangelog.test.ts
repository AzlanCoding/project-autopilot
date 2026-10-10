import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { UserService } from '../src/services/userService';
import type { PreProccessChatMsg } from '../src/services/botService';

const t = (hhmm: string) => new Date(`2026-10-10T${hhmm}:00+08:00`).getTime() / 1000;

/** A UserService without a database, using a changelog with a change at 12:00. */
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'changelog-'));
  const changelogPath = path.join(dir, 'changelog.json');
  await fs.writeFile(changelogPath, JSON.stringify([{ date: '2026-10-10T12:00:00+08:00', summary: 'No --- dividers.' }]));
  const users = Object.create(UserService.prototype) as UserService;
  Object.assign(users, {
    store: { toolCallHist: { followTrail: async () => [] } },
    generateUserStringFromJid: async (jid: string) => jid,
    promptChangelogPath: changelogPath,
  });
  return users;
}

const msg = (user: string, hhmm: string, text: string): PreProccessChatMsg => ({ id: hhmm, user, time: t(hhmm), text });
const summarise = (items: any[]) => items.map(i => i.role == 'system' ? 'NOTE' : `${i.role}: ${(i.content as string).split('\n')[0]}`);

test('a prompt change is noted where it happened in the history', async () => {
  const users = await setup();
  const [history] = await users.formatAndMergeMessages([
    msg('azlan', '11:00', 'hi'), msg('AI', '11:01', 'hello ---'), msg('azlan', '12:30', 'thanks'),
  ], 12);
  assert.deepEqual(summarise(history), ['user: azlan:', 'assistant: hello ---', 'NOTE', 'user: azlan:']);
  assert.match((history[2] as any).content, /updated at 10\/10\/2026.*\(12:00:00\)\. What changed: No --- dividers\./);
});

test('a prompt change after the last message is noted at the end, before the reply', async () => {
  const users = await setup();
  const [history] = await users.formatAndMergeMessages([msg('azlan', '11:00', 'hi'), msg('AI', '11:01', 'hello')], 12);
  assert.deepEqual(summarise(history), ['user: azlan:', 'assistant: hello', 'NOTE']);
});

test('no note when every message came after the change, or the change is outside the history window', async () => {
  const users = await setup();
  const [after] = await users.formatAndMergeMessages([msg('azlan', '12:30', 'hi'), msg('AI', '12:31', 'hello')], 12);
  assert.deepEqual(summarise(after), ['user: azlan:', 'assistant: hello']);
  const [windowed] = await users.formatAndMergeMessages([
    msg('azlan', '11:00', 'old'), msg('AI', '11:01', 'old reply'), msg('azlan', '12:30', 'a'), msg('AI', '12:31', 'b'),
  ], 2);
  assert.deepEqual(summarise(windowed), ['user: azlan:', 'assistant: b']);
});
