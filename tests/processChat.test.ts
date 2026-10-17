import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { z } from 'zod';
import AI from '../src/services/ai';

/** Builds an AI instance with a fake Responses API that streams `turns` (one list of output items per request). */
function fakeAI(turns: any[][], extraTools: any[] = []) {
  const requests: any[][] = [];
  const ai = Object.create(AI.prototype) as AI;
  Object.assign(ai, {
    logger: pino({ level: 'silent' }),
    memoryQueryTool: { func: async () => '[]' },
    tools: [{ name: 'memory_write', description: 'Save a memory', schema: z.object({ text: z.string() }), invoke: async () => 'Memory saved.' }, ...extraTools],
    openai: {
      responses: {
        create: async (params: any) => {
          requests.push(structuredClone(params.input));
          const items = turns[requests.length - 1];
          return (async function* () {
            for (const item of items) {
              if (item.type == 'message') {
                yield { type: 'response.output_text.delta', delta: item.content[0].text };
              }
              yield { type: 'response.output_item.done', item };
            }
          })();
        }
      }
    },
  });
  return { ai, requests };
}

const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('text sent before a tool call is in the history of the request after it, so Sofia does not reply twice', async () => {
  const { ai, requests } = fakeAI([
    [message('Noted! Saving that 💾\n\n'), { type: 'function_call', call_id: 'c1', name: 'memory_write', arguments: '{"text":"repo link"}' }],
    [message('All locked in 😴')],
  ]);
  const sent: string[] = [];
  for await (const y of ai.processChatv3([{ role: 'user', content: 'Azlan:\nremember the repo link', type: 'message' }])) {
    if (y.type == 'chunk_display') {
      sent.push(y.content as string);
    }
  }
  assert.deepEqual(sent, ['Noted! Saving that 💾', 'All locked in 😴']);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].map((i: any) => i.type == 'message' ? `${i.role}: ${i.content}` : i.type), [
    'user: Azlan:\nremember the repo link',
    'assistant: Noted! Saving that 💾\n\n',
    'function_call',
    'function_call_output',
  ]);
});

test('messages that arrive during a reply are added after the tool call, before the model continues', async () => {
  const { ai, requests } = fakeAI([
    [message('Saving that 💾\n\n'), { type: 'function_call', call_id: 'c1', name: 'memory_write', arguments: '{"text":"repo link"}' }],
    [message('Saved! And chem is next Tuesday')],
  ]);
  const newMessages = [
    { role: 'system', content: 'New messages arrived while you were replying.', type: 'message' },
    { role: 'user', content: 'Mary:\nwhat about chem', type: 'message' },
  ] as any[];
  let calls = 0;
  for await (const _ of ai.processChatv3([{ role: 'user', content: 'Azlan:\nremember the repo link', type: 'message' }], undefined, {}, async () => calls++ ? [] : newMessages)) { }
  assert.equal(calls, 1); // Only checked before continuing after a tool call
  assert.deepEqual(requests[1].slice(-2), newMessages);
});

const call = (name: string, args: object, id = name) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const fakeTool = (name: string, calls: string[], result: unknown = 'Sent') =>
  ({ name, description: name, schema: z.object({}).passthrough(), invoke: async (args: any) => { calls.push(`${name} ${JSON.stringify(args)}`); return result; } });

async function run(ai: AI) {
  const sent: string[] = [];
  for await (const y of ai.processChatv3([{ role: 'user', content: 'Azlan:\nthanks!', type: 'message' }])) {
    if (y.type == 'chunk_display') sent.push(y.content as string);
  }
  return sent;
}

test('a sticker sent with end_message ends the reply: no more text and no further request', async () => {
  const calls: string[] = [];
  const { ai, requests } = fakeAI([
    [message('Anytime!\n\n'), call('send_sticker_gif', { sticker_id: 'stk_1', end_message: true }), message('Also, want to plan your week?')],
    [message('should never be requested')],
  ], [fakeTool('send_sticker_gif', calls)]);
  assert.deepEqual(await run(ai), ['Anytime!']);
  assert.deepEqual(calls, ['send_sticker_gif {"sticker_id":"stk_1","end_message":true}']);
  assert.equal(requests.length, 1);
});

test('end_message only takes effect after the last tool call of the turn', async () => {
  const calls: string[] = [];
  const { ai, requests } = fakeAI([
    [call('end_message', {}), call('send_sticker_gif', { sticker_id: 'stk_1', end_message: false }), call('memory_write', { text: 'likes cats' })],
    [message('should never be requested')],
  ], [fakeTool('end_message', calls, 'Reply ended.'), fakeTool('send_sticker_gif', calls)]);
  assert.deepEqual(await run(ai), []);
  // The sticker is still sent even though end_message came first, then the reply ends
  assert.deepEqual(calls, ['end_message {}', 'send_sticker_gif {"sticker_id":"stk_1","end_message":false}']);
  assert.equal(requests.length, 1);
});

test('end_message: false keeps the reply going, and a failed send does not end it', async () => {
  const calls: string[] = [];
  const failing = { name: 'send_sticker_gif_to_chat', description: 'x', schema: z.object({}).passthrough(), usage_str: '{}', invoke: async () => { throw Error('Unknown sticker'); } };
  const { ai, requests } = fakeAI([
    [call('send_sticker_gif', { sticker_id: 'stk_1', end_message: false }), call('send_sticker_gif_to_chat', { id: 'x', sticker_id: 'bad', end_message: true })],
    [message('Sorry, that sticker is gone')],
  ], [fakeTool('send_sticker_gif', calls), failing]);
  assert.deepEqual(await run(ai), ['Sorry, that sticker is gone']);
  assert.equal(requests.length, 2);
});

test('an image from view_media is shown to the model after the tool outputs', async () => {
  const image = { dataUrl: 'data:image/png;base64,AAAA', animated: true, width: 1, height: 1, downscaled: false };
  const { ai, requests } = fakeAI([
    [call('view_media', { media_id: 'ABC' })],
    [message('Cute cat!')],
  ], [fakeTool('view_media', [], { text: 'GIF ABC is attached in the next message. It is animated (moving), you can only see its first frame.', image })]);
  assert.deepEqual(await run(ai), ['Cute cat!']);
  const [output, shown] = requests[1].slice(-2);
  assert.equal(output.type, 'function_call_output');
  assert.match(output.output, /first frame/);
  assert.equal(shown.role, 'user');
  assert.deepEqual(shown.content[1], { type: 'input_image', image_url: image.dataUrl, detail: 'auto' });
});
