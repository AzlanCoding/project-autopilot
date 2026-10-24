import 'dotenv/config';

/**
 * OpenAI compatible base URL for Alibaba Model Studio, e.g. `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`.
 * The workspace URL is also needed for the decision model (`/systemone`), which is not served on the shared dashscope host.
 */
export const MODELSTUDIO_BASE_URL = (process.env.MODELSTUDIO_WORKSPACE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, '');

// Alibaba Model Studio model used for chats and scheduled tasks and can read images
export const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen3.8-flash';

/**
 * Model Studio's built-in tools Sofia can use in the Responses API, run on Alibaba's side within one request
 * (`BUILTIN_TOOLS`, comma separated, off unless set). Off by default because web searches are expensive: one news
 * question took 46k-111k input tokens (several searches and page reads) against ~5k for a normal reply (tested 2026-10-24).
 */
export const BUILTIN_TOOL_TYPES = ['code_interpreter', 'web_search', 'web_extractor'] as const;
const builtinSetting = process.env.BUILTIN_TOOLS?.trim().toLowerCase();
export const BUILTIN_TOOLS: string[] = !builtinSetting || builtinSetting == 'none' ? []
  : builtinSetting.split(',').map(t => t.trim()).filter(t => (BUILTIN_TOOL_TYPES as readonly string[]).includes(t));

// Alibaba Model Studio model used for describing stickers
export const STICKER_PROCESSING_MODEL = process.env.STICKER_PROCESSING_MODEL || CHAT_MODEL;
