import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { z } from 'zod';
import AI from '../src/services/ai';

/** Builds an AI instance with a fake Responses API that streams `turns` (one list of output items per request). */
function fakeAI(turns: any[][]) {
  const requests: any[][] = [];
  const ai = Object.create(AI.prototype) as AI;
  Object.assign(ai, {
    logger: pino({ level: 'silent' }),
    memoryQueryTool: { func: async () => '[]' },
    tools: [{ name: 'memory_write', description: 'Save a memory', schema: z.object({ text: z.string() }), invoke: async () => 'Memory saved.' }],
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
