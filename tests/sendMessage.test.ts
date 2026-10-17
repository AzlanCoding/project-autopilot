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
  });
  const result = await ai.sendMessageTool!.invoke({ id: 'john', messages: ['Hey John! 😄', 'Sofia here', 'Quick question', 'No rush!'] });
  assert.equal(result, '4 messages sent');
  assert.deepEqual(sent.map(([, text, label]) => [text, label]), [
    ['Hey John! 😄', true], ['Sofia here', false], ['Quick question', false], ['No rush!', false],
  ]);
});
