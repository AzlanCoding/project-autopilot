import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { z } from 'zod';
import AI, { describeBuiltinToolCall } from '../src/services/ai';
import { replyEnding, UNFINISHED_NUDGE } from '../src/services/unfinishedReply';
import { messageBreakIndex, splitIntoMessages } from '../src/utils/common';

/** Builds an AI instance with a fake Responses API that streams `turns` (one list of output items per request). */
function fakeAI(turns: any[][], extraTools: any[] = []) {
  const requests: any[][] = [];
  /** The `tools` sent with each request */
  const toolsSent: any[][] = [];
  const ai = Object.create(AI.prototype) as AI;
  Object.assign(ai, {
    logger: pino({ level: 'silent' }),
    memoryQueryTool: { func: async () => '[]' },
    aboutToAct: async () => 0, // Never nudge unless a test says so
    builtinTools: [],
    tools: [{ name: 'memory_write', description: 'Save a memory', schema: z.object({ text: z.string() }), invoke: async () => 'Memory saved.' }, ...extraTools],
    openai: {
      responses: {
        create: async (params: any) => {
          requests.push(structuredClone(params.input));
          toolsSent.push(params.tools);
          const items = turns[requests.length - 1];
          return (async function* () {
            for (const item of items) {
              if (item.event) {
                yield item.event; // A raw stream event, e.g. `response.failed`
                continue;
              }
              if (item.type == 'message') {
                // `chunks` streams the text in pieces, like the real API
                for (const delta of item.chunks ?? [item.content[0].text]) {
                  yield { type: 'response.output_text.delta', delta };
                }
              }
              yield { type: 'response.output_item.done', item };
            }
          })();
        }
      }
    },
  });
  return { ai, requests, toolsSent };
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
  const failing = { name: 'send_poll', description: 'x', schema: z.object({}).passthrough(), usage_str: '{}', invoke: async () => { throw Error('Unknown sticker'); } };
  const { ai, requests } = fakeAI([
    [call('send_sticker_gif', { sticker_id: 'stk_1', end_message: false }), call('send_poll', { question: 'bad', options: [], end_message: true })],
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

/** Runs a reply, logging what is sent to the user and when the unfinished-reply check runs. */
async function runLogged(ai: AI, probabilities: (number | Error)[]) {
  const log: string[] = [];
  ai.aboutToAct = async (text: string) => {
    log.push(`check: ${text}`);
    const p = probabilities.shift() ?? 0;
    if (p instanceof Error) throw p;
    return p;
  };
  for await (const y of ai.processChatv3([{ role: 'user', content: 'Azlan:\nsend a test to the testing group', type: 'message' }])) {
    if (y.type == 'chunk_display') log.push(`sent: ${y.content}`);
    if (y.type == 'tool_call') log.push(`tool: ${(y as any).data.name}`);
  }
  return log;
}

test('a reply that stops at "Going in now!" without a tool call gets one nudge, and then does it', async () => {
  const calls: string[] = [];
  const { ai, requests } = fakeAI([
    [message("Here's what I'm sending\n\nGoing in now! 🚀")],
    [call('send_message', { id: 'grp', messages: ['test'] })],
    [message('Sent! ✅')],
  ], [fakeTool('send_message', calls)]);
  const log = await runLogged(ai, [0.94]);
  assert.deepEqual(log, [
    "sent: Here's what I'm sending",
    'sent: Going in now! 🚀', // The last chunk reaches the user before the check runs
    "check: Here's what I'm sending\n\nGoing in now! 🚀",
    'tool: send_message',
    'sent: Sent! ✅', // Not checked again: only one nudge per reply
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(requests[1].slice(-1)[0], { role: 'system', content: UNFINISHED_NUDGE, type: 'message' });
});

test('a finished reply is not nudged', async () => {
  const { ai, requests } = fakeAI([[message('Monday is Responsible AI at 9am ✨')]]);
  assert.deepEqual(await runLogged(ai, [0.02]), ['sent: Monday is Responsible AI at 9am ✨', 'check: Monday is Responsible AI at 9am ✨']);
  assert.equal(requests.length, 1);
});

test('Sofia is only nudged once per reply, and a failing check does not break the reply', async () => {
  const twice = fakeAI([[message('Let me check!')], [message('Give me a sec!')], [message('never requested')]]);
  assert.deepEqual(await runLogged(twice.ai, [0.9, 0.9]), ['sent: Let me check!', 'check: Let me check!', 'sent: Give me a sec!']);
  assert.equal(twice.requests.length, 2);

  const failing = fakeAI([[message('Going in now!')]]);
  assert.deepEqual(await runLogged(failing.ai, [Error('decision model down')]), ['sent: Going in now!', 'check: Going in now!']);
  assert.equal(failing.requests.length, 1);
});

test('a reply ended by a tool is not checked', async () => {
  const { ai } = fakeAI([[message('Anytime!\n\n'), call('end_message', {})]], [fakeTool('end_message', [], 'Reply ended.')]);
  assert.deepEqual(await runLogged(ai, [0.9]), ['sent: Anytime!', 'tool: end_message']);
});

test('the unfinished check only looks at the last message of a reply', () => {
  // The whole 10 message reply on 17 Oct scored 0.77 "about to act" because of its middle, its ending is an offer
  assert.equal(replyEnding("Here's your prompt 👇\n\n```\nSend the daily 7am message...\n```\n\nWant me to fire one more dry run at the Testing Group Chat?\n"),
    'Want me to fire one more dry run at the Testing Group Chat?');
  assert.equal(replyEnding("Here's what I'm sending\n\n  \n\nGoing in now! 🚀"), 'Going in now! 🚀');
  assert.equal(replyEnding('Single message'), 'Single message');
});

const PROMPT_REPLY = "Here's your prompt rewritten 👇\n\n```\nSend the daily 7am message.\n\nStructure it like this:\n\n1. Greeting\n2. 📚 For everyone\n```\n\nWant me to do a dry run?";

test('a code block with blank lines is sent as one message, even when it streams in small pieces', async () => {
  const chunks = PROMPT_REPLY.match(/[\s\S]{1,5}/gu)!; // 5 characters at a time
  const { ai } = fakeAI([[{ ...message(PROMPT_REPLY), chunks }]]);
  assert.deepEqual(await run(ai), [
    "Here's your prompt rewritten 👇",
    '```\nSend the daily 7am message.\n\nStructure it like this:\n\n1. Greeting\n2. 📚 For everyone\n```',
    'Want me to do a dry run?',
  ]);
});

test('message breaks skip code blocks, one line monospace and empty messages', () => {
  assert.equal(messageBreakIndex('a\n\nb'), 1);
  assert.equal(messageBreakIndex('```\na\n\nb'), -1); // Still inside the block
  assert.equal(messageBreakIndex('use ```x``` here\n\nnext'), 16); // ```x``` opens and closes on one line
  assert.deepEqual(splitIntoMessages('one\n\n\n\ntwo\n\n   \n\n```\nx\n\ny\n```'), ['one', 'two', '```\nx\n\ny\n```']);
  assert.deepEqual(splitIntoMessages('before\n\n```\nnever closed\n\nstill in it'), ['before', '```\nnever closed\n\nstill in it']);
  // The unfinished check judges the last message as sent, not the last paragraph inside a code block
  assert.equal(replyEnding("Here it is:\n\n```\nline 1\n\nline 2\n```"), '```\nline 1\n\nline 2\n```');
});

const reasoning = (text: string, id = 'r1') => ({ type: 'reasoning', id, summary: [{ type: 'summary_text', text }] });
const arrived = [
  { role: 'system', content: 'New messages arrived while you were replying.', type: 'message' },
  { role: 'user', content: 'Azlan:\nas in for tier 4', type: 'message' },
] as any[];

/** Runs a reply where `hasNewMessages` returns the given answers in order (then false), logging what is sent. */
async function runInterrupted(ai: AI, answers: boolean[], newMessages: () => any[] = () => arrived) {
  const sent: string[] = [];
  let checks = 0;
  for await (const y of ai.processChatv3([{ role: 'user', content: 'Azlan:\nwhy not sign in with Google?', type: 'message' }], undefined, {},
    async () => newMessages(), () => answers[checks++] ?? false)) {
    if (y.type == 'chunk_display') sent.push(y.content as string);
  }
  return sent;
}

const summary = (items: any[]) => items.map((i: any) => i.type == 'message' ? `${i.role}: ${i.content}` : i.type);

test('a message that arrives while Sofia is thinking stops the response before any text is sent, keeping her thinking', async () => {
  const { ai, requests } = fakeAI([
    [reasoning('Plan a reply about Google sign-in'), message('A whole reply that ignores tier 4')],
    [message('For tier 4, use real Google sign-in')],
  ]);
  assert.deepEqual(await runInterrupted(ai, [true]), ['For tier 4, use real Google sign-in']);
  assert.deepEqual(summary(requests[1]), ['user: Azlan:\nwhy not sign in with Google?', 'reasoning', ...summary(arrived)]);
  assert.equal(requests[1][1].summary[0].text, 'Plan a reply about Google sign-in');
});

test('a message that arrives mid-text stops after the WhatsApp message being sent, and only sent text is kept', async () => {
  const { ai, requests } = fakeAI([
    [{ ...message('Yes, do Google!\n\nKeep the secret server-side\n\nAnd publish the consent screen'), chunks: ['Yes, do Google!\n\n', 'Keep the secret server-side\n\n', 'And publish the consent screen'] }],
    [message('Oh, for tier 4 specifically: mint your own short session')],
  ]);
  assert.deepEqual(await runInterrupted(ai, [false, true]), ['Yes, do Google!', 'Keep the secret server-side', 'Oh, for tier 4 specifically: mint your own short session']);
  const history = summary(requests[1]);
  assert.deepEqual(history.slice(1, 3), ['assistant: Yes, do Google!\n\nKeep the secret server-side', `system: ${(requests[1][2] as any).content}`]);
  assert.match(history[2], /were already sent/);
  assert.deepEqual(history.slice(3), summary(arrived));
});

test('a message that arrives during tool calls stops after the tool that has run, the rest are not run', async () => {
  const calls: string[] = [];
  const { ai, requests } = fakeAI([
    [call('memory_write', { text: 'google login' }), call('send_sticker_gif', { sticker_id: 'stk_1', end_message: false })],
    [message('Saved! And for tier 4...')],
  ], [fakeTool('send_sticker_gif', calls)]);
  assert.deepEqual(await runInterrupted(ai, [true]), ['Saved! And for tier 4...']);
  assert.deepEqual(calls, [], 'the sticker was never sent');
  assert.deepEqual(summary(requests[1]).slice(1), ['function_call', 'function_call_output', ...summary(arrived)]);
});

test('a reply is stopped at most twice, and not at all if no new messages are returned', async () => {
  const { ai, requests } = fakeAI([
    [reasoning('1'), message('never sent')],
    [reasoning('2'), message('never sent either')],
    [reasoning('3'), message('Finally replying')],
  ]);
  assert.deepEqual(await runInterrupted(ai, [true, true, true, true]), ['Finally replying']);
  assert.equal(requests.length, 3);

  // e.g. in a group chat, where the new messages weren't meant for Sofia
  const quiet = fakeAI([[reasoning('1'), message('Normal reply')]]);
  assert.deepEqual(await runInterrupted(quiet.ai, [true], () => []), ['Normal reply']);
  assert.equal(quiet.requests.length, 1);
});

test("Sofia's thinking is kept for the next request whether the model puts it in `summary` (Qwen) or `content` (DeepSeek)", async () => {
  const qwen = { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'Qwen thinks here' }], content: [] };
  const deepseek = { type: 'reasoning', id: 'r2', summary: [], content: [{ type: 'reasoning_text', text: 'DeepSeek thinks here' }] };
  const { ai, requests } = fakeAI([
    [qwen, call('memory_write', { text: 'a' }, 'c1')],
    [deepseek, call('memory_write', { text: 'b' }, 'c2')],
    [message('Done!')],
  ]);
  assert.deepEqual(await run(ai), ['Done!']);
  const reasoning = requests[2].filter((i: any) => i.type == 'reasoning');
  assert.deepEqual(reasoning, [
    { id: 'r1', summary: qwen.summary, type: 'reasoning' }, // Empty content is left out
    { id: 'r2', summary: [], content: deepseek.content, type: 'reasoning' },
  ]);
});

test('a failed model request (e.g. an unknown model id) throws instead of silently ending the reply', async () => {
  const { ai } = fakeAI([[
    { event: { type: 'response.created' } },
    { event: { type: 'response.failed', response: { error: { code: 'server_error', message: 'Model not found: DeepSeek-V4.1-Flash-1017' } } } },
  ]]);
  await assert.rejects(run(ai), /Model request failed \(server_error\): Model not found: DeepSeek-V4.1-Flash-1017/);
  const errored = fakeAI([[{ event: { type: 'error', code: 'rate_limit', message: 'Too many requests' } }]]);
  await assert.rejects(run(errored.ai), /Model request failed \(rate_limit\): Too many requests/);
});

test("Model Studio's built-in tools are off by default", async () => {
  process.env.ALIBABA_API_KEY ||= 'test'; // The OpenAI client needs a key to be created, no requests are made
  assert.deepEqual(new AI({} as any, pino({ level: 'silent' })).builtinTools, []); // BUILTIN_TOOLS isn't set in tests
  const { ai, toolsSent } = fakeAI([[message('Hi!')]]);
  await run(ai);
  assert.deepEqual(toolsSent[0].filter((t: any) => t.type != 'function'), []);
  // Sofia isn't told about tools she doesn't have
  assert.equal(ai.builtinToolsPrompt(), '');
  assert.equal(ai.builtinToolsPrompt(['code_interpreter']).includes('web_search'), false);
  assert.match(ai.builtinToolsPrompt(['web_search', 'web_extractor', 'code_interpreter']), /search the web \(`web_search`\), read web pages \(`web_extractor`\), run Python code/);
});

test("Model Studio's built-in tools are sent with Sofia's tools when turned on, and their calls are kept in the history and saved", async () => {
  const search = { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', query: 'NYP news October 2026', sources: [] } };
  const { ai, requests, toolsSent } = fakeAI([
    [search, message('NYP launched Lumina this month!\n\n'), call('memory_write', { text: 'Azlan follows NYP news' })],
    [message('Saved that too')],
  ]);
  ai.builtinTools = ['code_interpreter', 'web_search', 'web_extractor'];
  const builtins: any[] = [];
  const sent: string[] = [];
  for await (const y of ai.processChatv3([{ role: 'user', content: 'Azlan:\nany NYP news?', type: 'message' }])) {
    if (y.type == 'builtin_tool_call') builtins.push((y as any).data);
    if (y.type == 'chunk_display') sent.push(y.content as string);
  }
  assert.deepEqual(toolsSent[0].filter((t: any) => t.type != 'function'), [{ type: 'code_interpreter' }, { type: 'web_search' }, { type: 'web_extractor' }]);
  assert.ok(toolsSent[0].some((t: any) => t.type == 'function' && t.name == 'memory_write'));
  assert.deepEqual(builtins, [search]); // botService saves these to ToolCallHist
  assert.deepEqual(sent, ['NYP launched Lumina this month!', 'Saved that too']);
  assert.deepEqual(summary(requests[1]).slice(1), ['web_search_call', 'assistant: NYP launched Lumina this month!\n\n', 'function_call', 'function_call_output']);
  assert.equal(describeBuiltinToolCall(search), 'web_search "NYP news October 2026"');
});
