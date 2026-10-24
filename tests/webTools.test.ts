import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import AI from '../src/services/ai';
import { chatProvider } from '../src/config/modelStudio';
import { formatPage, formatSearchResults, webFetch, webSearch } from '../src/services/webTools';

const OPTIONS = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' };

/** Replaces `fetch` with one that records requests and answers with `respond`. */
function stubFetch(respond: (url: string, body: any) => { status?: number, json: any }) {
  const calls: { url: string, body: any, auth: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.Authorization });
    const { status = 200, json } = respond(url, body);
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const result = (n: number, summary = 'S'.repeat(2000)) => ({
  title: `Result ${n}`, url: `https://example.com/${n}`, site_name: n == 1 ? 'Example' : null, date: n == 1 ? '2026-10-24T08:00:00Z' : null,
  summary, snippet: 'short', content: '', rerank_score: 1.8, authority: 3, site_icon: null,
});

test('the chat provider is DeepSeek only for api.deepseek.com, everything else is Model Studio', () => {
  assert.equal(chatProvider('https://api.deepseek.com'), 'deepseek');
  assert.equal(chatProvider('https://api.deepseek.com/v1/'), 'deepseek');
  assert.equal(chatProvider('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'modelstudio');
  assert.equal(chatProvider('https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), 'modelstudio');
  assert.equal(chatProvider('not a url'), 'modelstudio');
});

test("DeepSeek search sends the query and the user's question, and results are trimmed for Sofia", async () => {
  const stub = stubFetch(() => ({ json: { results: [result(1), result(2, 'short summary')] } }));
  try {
    const results = await webSearch('NYP news', { count: 3, question: 'any NYP news this week?' }, OPTIONS);
    assert.deepEqual(stub.calls, [{ url: 'https://api.deepseek.com/v1/tools/search', body: { query: 'NYP news', count: 3, ori_question: 'any NYP news this week?' }, auth: 'Bearer sk-test' }]);
    const text = formatSearchResults(results);
    assert.match(text, /^1\. Result 1 \(Example\), 2026-10-24\nhttps:\/\/example\.com\/1\nS{1200}\.\.\.\n\n2\. Result 2\nhttps:\/\/example\.com\/2\nshort summary$/);
    assert.equal(formatSearchResults([]), 'No results found. Try different words.');
  }
  finally {
    stub.restore();
  }
});

test('DeepSeek fetch returns the page, long pages are cut off, and errors say why', async () => {
  const stub = stubFetch((_url, body) => body.url.includes('missing')
    ? { status: 404, json: { error: { message: 'failed to fetch URL', type: 'not_found_error', param: null, code: 'invalid_request_error' } } }
    : { json: { title: 'Forecast', content: 'x'.repeat(25000) } });
  try {
    const page = await webFetch('https://www.weather.gov.sg/', OPTIONS);
    const text = formatPage('https://www.weather.gov.sg/', page);
    assert.match(text, /^Forecast\nhttps:\/\/www\.weather\.gov\.sg\/\n\nx{20000}\n\n\[Page cut off after 20000 of 25000 characters\]$/);
    await assert.rejects(webFetch('https://example.com/missing', OPTIONS), /Fetch failed \(HTTP 404\): failed to fetch URL/);
    assert.equal(formatPage('https://example.com', { title: '', content: '' }), 'https://example.com\nhttps://example.com\n\n(The page has no readable content.)');
  }
  finally {
    stub.restore();
  }
});

test("Sofia's web_search tool calls DeepSeek Search and formats the results", async () => {
  process.env.ALIBABA_API_KEY ||= 'test';
  const ai = new AI({} as any, pino({ level: 'silent' }));
  const stub = stubFetch(() => ({ json: { results: [result(1, 'Thundery showers in the afternoon')] } }));
  try {
    const out = await ai.webSearchTool.invoke({ query: 'Singapore weather tomorrow' });
    assert.equal(stub.calls[0].body.count, 5);
    assert.match(out as string, /Result 1 \(Example\).*\nhttps:\/\/example\.com\/1\nThundery showers in the afternoon$/);
  }
  finally {
    stub.restore();
  }
});
