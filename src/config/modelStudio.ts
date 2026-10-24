import 'dotenv/config';

/**
 * OpenAI compatible base URL for Alibaba Model Studio, e.g. `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`.
 * The workspace URL is also needed for the decision model (`/systemone`), which is not served on the shared dashscope host.
 * Embeddings, the decision model and sticker descriptions always use Model Studio, whichever provider Sofia chats with.
 */
export const MODELSTUDIO_BASE_URL = (process.env.MODELSTUDIO_WORKSPACE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, '');

/**
 * OpenAI compatible base URL and API key for Sofia's chats and scheduled tasks (the Responses API). Model Studio unless set,
 * e.g. `CHAT_BASE_URL=https://api.deepseek.com` with a DeepSeek `CHAT_API_KEY` and `CHAT_MODEL=deepseek-flash`.
 */
export const CHAT_BASE_URL = (process.env.CHAT_BASE_URL || MODELSTUDIO_BASE_URL).replace(/\/+$/, '');
export const CHAT_API_KEY = process.env.CHAT_API_KEY || process.env.ALIBABA_API_KEY;

/** Which provider Sofia chats with, decides which web tools she gets (see `USE_WEB_TOOLS`). */
export const CHAT_PROVIDER: 'modelstudio' | 'deepseek' = chatProvider(CHAT_BASE_URL);
export function chatProvider(baseUrl: string): 'modelstudio' | 'deepseek' {
  try {
    return new URL(baseUrl).hostname == 'api.deepseek.com' ? 'deepseek' : 'modelstudio';
  }
  catch {
    return 'modelstudio';
  }
}

// Model used for chats and scheduled tasks, it can read images
export const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen3.8-flash';

/**
 * Lets Sofia search the web and read web pages (`USE_WEB_TOOLS=true`, off by default). On Model Studio these are its
 * built-in `web_search` and `web_extractor` tools, run by Alibaba within the response. On DeepSeek they are function tools
 * calling DeepSeek's Search & Fetch APIs (see `webTools.ts`). Off by default because searches are slow and costly: on
 * Model Studio one news question took 46k-111k input tokens against ~5k for a normal reply (tested 2026-10-24).
 */
export const USE_WEB_TOOLS = process.env.USE_WEB_TOOLS?.trim().toLowerCase() == 'true';

/** Model Studio's built-in tools sent with each request: only the web tools, and only when chatting through Model Studio. */
export const BUILTIN_TOOLS: string[] = USE_WEB_TOOLS && CHAT_PROVIDER == 'modelstudio' ? ['web_search', 'web_extractor'] : [];

// Model Studio model used for describing stickers. Falls back to CHAT_MODEL only if that is a Model Studio model.
export const STICKER_PROCESSING_MODEL = process.env.STICKER_PROCESSING_MODEL || (CHAT_PROVIDER == 'modelstudio' ? CHAT_MODEL : 'qwen3.8-flash');
