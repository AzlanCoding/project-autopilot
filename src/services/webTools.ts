import { CHAT_API_KEY, CHAT_BASE_URL } from '../config/modelStudio';

/**
 * DeepSeek's Search & Fetch APIs (https://api-docs.deepseek.com/guides/search), used for Sofia's `web_search` and `web_fetch`
 * tools when she chats through DeepSeek. Unlike Model Studio's built-in tools they are plain endpoints our code calls.
 * $0.75 per 1,000 successful requests each (errors and empty results aren't billed).
 */

/** Each search result's `summary` is ~2,000-2,500 characters, 5 untrimmed results cost ~3k tokens. */
const SUMMARY_MAX_CHARS = 1200;
/** Fetched pages are Markdown and can be very long. */
const PAGE_MAX_CHARS = 20000;

export interface WebSearchResult {
  title: string,
  url: string,
  site_name: string | null,
  date: string | null,
  summary: string,
  rerank_score: number,
  authority: number,
}

async function deepseekTool<T>(path: 'search' | 'fetch', body: object, options: { baseUrl?: string, apiKey?: string } = {}): Promise<T> {
  const res = await fetch(`${options.baseUrl ?? CHAT_BASE_URL}/v1/tools/${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${options.apiKey ?? CHAT_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => null) as any;
  if (!res.ok) {
    throw Error(`${path == 'search' ? 'Search' : 'Fetch'} failed (HTTP ${res.status}): ${json?.error?.message ?? 'no message'}`);
  }
  return json as T;
}

/** Searches the web, best results first. `question` is the user's original question, it helps DeepSeek understand the query. */
export async function webSearch(query: string, { count = 5, question }: { count?: number, question?: string } = {}, options?: { baseUrl?: string, apiKey?: string }): Promise<WebSearchResult[]> {
  const { results } = await deepseekTool<{ results: WebSearchResult[] }>('search', {
    query: query.slice(0, 128),
    count,
    ...(question?.trim() ? { ori_question: question.trim().slice(0, 128) } : {}),
  }, options);
  return results;
}

/** Reads a web page as Markdown. */
export async function webFetch(url: string, options?: { baseUrl?: string, apiKey?: string }): Promise<{ title: string, content: string }> {
  return deepseekTool('fetch', { url }, options);
}

/** Formats search results for Sofia. */
export function formatSearchResults(results: WebSearchResult[]): string {
  if (results.length == 0) {
    return 'No results found. Try different words.';
  }
  return results.map((r, i) => {
    const summary = r.summary.length > SUMMARY_MAX_CHARS ? `${r.summary.slice(0, SUMMARY_MAX_CHARS)}...` : r.summary;
    return `${i + 1}. ${r.title}${r.site_name ? ` (${r.site_name})` : ''}${r.date ? `, ${r.date.slice(0, 10)}` : ''}\n${r.url}\n${summary}`;
  }).join('\n\n');
}

/** Formats a fetched page for Sofia, cut off if it is very long. */
export function formatPage(url: string, page: { title: string, content: string }): string {
  const content = page.content.length > PAGE_MAX_CHARS
    ? `${page.content.slice(0, PAGE_MAX_CHARS)}\n\n[Page cut off after ${PAGE_MAX_CHARS} of ${page.content.length} characters]`
    : page.content;
  return `${page.title || url}\n${url}\n\n${content || '(The page has no readable content.)'}`;
}
