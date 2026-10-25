import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import AI from '../src/services/ai';

test('send_message labels only the first message as from the AI, like normal replies', async () => {
  process.env.ALIBABA_API_KEY ||= 'test'; // The OpenAI client needs a key to be created, no requests are made
  const sent: [string, string, boolean | undefined][] = [];
  const ai = new AI({} as any, pino({ level: 'silent' }));
  ai.registerChatTools({
    sendMessage: async (id: string, text: string, label?: boolean) => { sent.push([id, text, label]); },
    sendStickerGif: async () => { }, getMedia: async () => { throw Error('unused'); }, listGroups: async () => [], getGroupInfo: async () => { throw Error('unused'); }, sendFile: async () => { }, loadChatById: async () => [],
    sendPoll: async () => 'unused', getPollResults: async () => null,
  });
  const result = await ai.sendMessageTool!.invoke({ id: 'john', messages: ['Hey John! 😄', 'Sofia here', 'Quick question', 'No rush!'] });
  assert.equal(result, '4 messages sent');
  assert.deepEqual(sent.map(([, text, label]) => [text, label]), [
    ['Hey John! 😄', true], ['Sofia here', false], ['Quick question', false], ['No rush!', false],
  ]);
});

test('send_sticker_gif goes to the chat Sofia is replying in, or the chat given', async () => {
  process.env.ALIBABA_API_KEY ||= 'test';
  const { chatContext } = await import('../src/services/chatContext');
  const sent: string[] = [];
  const sticker = { id: 'stk_1', status: 'approved' };
  const ai = new AI({ stickers: { findById: async (id: string) => id == 'stk_1' ? sticker : null } } as any, pino({ level: 'silent' }));
  ai.registerChatTools({
    sendMessage: async () => { }, getMedia: async () => { throw Error('unused'); }, listGroups: async () => [], getGroupInfo: async () => { throw Error('unused'); }, sendFile: async () => { }, loadChatById: async () => [],
    sendPoll: async () => 'unused', getPollResults: async () => null,
    sendStickerGif: async (id: string, s: any) => { sent.push(`${s.id} -> ${id}`); },
  });
  await chatContext.run({ chatId: 'current@g.us' }, async () => {
    await ai.sendStickerGifTool!.invoke({ sticker_id: 'stk_1', end_message: true });
    await ai.sendStickerGifTool!.invoke({ sticker_id: 'stk_1', id: 'john', end_message: false });
  });
  assert.deepEqual(sent, ['stk_1 -> current@g.us', 'stk_1 -> john']);
  await assert.rejects(ai.sendStickerGifTool!.invoke({ sticker_id: 'stk_1', end_message: true }), /not replying in a chat/);
  await assert.rejects(chatContext.run({ chatId: 'current@g.us' }, () => ai.sendStickerGifTool!.invoke({ sticker_id: 'stk_nope', end_message: true })), /Unknown sticker/);
});

test('read_chat_history with `after` returns the earliest messages after that Singapore time, and how to read more', async () => {
  process.env.ALIBABA_API_KEY ||= 'test';
  const sg = (time: string) => new Date(`2026-10-24T${time}+08:00`).getTime() / 1000;
  const history = [
    { user: 'mary', time: sg('14:59:00'), text: 'before' },
    { user: 'AI', time: sg('15:00:30'), text: 'first after' },
    { user: 'mary', time: sg('15:01:00'), text: 'second after' },
    { user: 'mary', time: sg('15:02:00'), text: 'third after' },
  ];
  const ai = new AI({ user: { generateUserStringFromJid: async () => 'Mary' } } as any, pino({ level: 'silent' }));
  ai.registerChatTools({
    sendMessage: async () => { }, sendStickerGif: async () => { }, getMedia: async () => { throw Error('unused'); }, listGroups: async () => [], getGroupInfo: async () => { throw Error('unused'); }, sendFile: async () => { },
    loadChatById: async () => history as any, sendPoll: async () => 'unused', getPollResults: async () => null,
  });
  const read = (args: object) => ai.readChatHistoryTool!.invoke({ id: 'mary', ...args }) as Promise<string>;

  // No offset: Singapore time, whatever the server's timezone is
  const page = await read({ after: '2026-10-24T15:00:00', limit: 2 });
  assert.deepEqual(page.split('\n').map(l => l.replace(/^\[.*?\] /, '')), [
    'You (Sofia): first after',
    'Mary: second after',
    '(1 more message after these, call again with after: "2026-10-24T15:01:00+08:00" to read them)',
  ]);
  assert.match(await read({ after: '2026-10-24T15:01:00+08:00' }), /^\[.*\] Mary: third after$/);
  assert.match(await read({ after: '2026-10-24T16:00:00+08:00' }), /^No messages found in this chat after/);
  // Without `after`, still the most recent messages
  assert.match(await read({ limit: 1 }), /third after$/);
  await assert.rejects(read({ after: 'yesterday 3pm' }), /Invalid `after`/);
});

test('get_group_info formats the group, and only takes group ids', async () => {
  process.env.ALIBABA_API_KEY ||= 'test';
  const ai = new AI({} as any, pino({ level: 'silent' }));
  ai.registerChatTools({
    sendMessage: async () => { }, sendStickerGif: async () => { }, getMedia: async () => { throw Error('unused'); }, listGroups: async () => [],
    loadChatById: async () => [], sendPoll: async () => 'unused', getPollResults: async () => null,
    sendFile: async () => { },
    getGroupInfo: async (id: string) => ({ id, name: 'GDGoC NYP', description: '', participants: [{ name: 'Azlan', userId: 'u1', description: 'GDGoC member', admin: true }] }),
  });
  assert.match(await ai.getGroupInfoTool!.invoke({ group_id: '123@g.us' }) as string, /^Group Chat: GDGoC NYP \(123@g\.us\)\n.*\n.*\n- Azlan \(user ID u1\) \[admin\]: GDGoC member$/);
  await assert.rejects(ai.getGroupInfoTool!.invoke({ group_id: 'u1' }), /not a group id/);
});
