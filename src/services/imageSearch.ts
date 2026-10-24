import { OpenAI } from 'openai';
import { MODELSTUDIO_BASE_URL } from '../config/modelStudio';
import { IMAGE_SEARCH_MODEL } from '../config/googleWorkspace';

/**
 * Image search with Model Studio's built-in `web_search_image` (text-to-image search). DeepSeek models reject this tool
 * (HTTP 400 on deepseek-v4.1-flash-1017, tested 2026-10-25), and adding it to Sofia's chat requests would break every reply
 * there, so it runs as its own request to a Qwen model. The results are read from the tool's output, not the reply text.
 */

export interface ImageResult {
  title: string,
  url: string,
}

let client: OpenAI | undefined;

/** Parses the image results out of a response's `web_search_image_call` items, without duplicates. */
export function imageResultsFromOutput(output: any[]): ImageResult[] {
  const seen = new Set<string>();
  const results: ImageResult[] = [];
  for (const item of output) {
    if (item?.type != 'web_search_image_call' || typeof item.output != 'string') continue;
    let parsed: any;
    try {
      parsed = JSON.parse(item.output);
    }
    catch {
      continue;
    }
    for (const r of Array.isArray(parsed) ? parsed : []) {
      if (typeof r?.url == 'string' && /^https?:\/\//.test(r.url) && !seen.has(r.url)) {
        seen.add(r.url);
        results.push({ title: String(r.title ?? '').trim(), url: r.url });
      }
    }
  }
  return results;
}

/** Finds images on the web for `query` (add "gif" for GIFs), best first. */
export async function searchImages(query: string, count = 8, openai?: OpenAI): Promise<ImageResult[]> {
  openai ??= client ??= new OpenAI({ apiKey: process.env.ALIBABA_API_KEY, baseURL: MODELSTUDIO_BASE_URL });
  const res: any = await openai.responses.create({
    model: IMAGE_SEARCH_MODEL,
    input: `Search for images of: ${query}\nCall the image search once with this query (and up to two close variations), then reply "done".`,
    tools: [{ type: 'web_search_image' } as any],
  });
  return imageResultsFromOutput(res.output ?? []).slice(0, count);
}
