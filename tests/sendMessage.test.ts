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
    sendStickerGif: async () => { }, getMedia: async () => { throw Error('unused'); }, listGroups: async () => [], loadChatById: async () => [],
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
    sendMessage: async () => { }, getMedia: async () => { throw Error('unused'); }, listGroups: async () => [], loadChatById: async () => [],
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
