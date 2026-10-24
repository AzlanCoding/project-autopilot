import 'dotenv/config';

/**
 * OpenAI compatible base URL for Alibaba Model Studio, e.g. `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`.
 * The workspace URL is also needed for the decision model (`/systemone`), which is not served on the shared dashscope host.
 */
export const MODELSTUDIO_BASE_URL = (process.env.MODELSTUDIO_WORKSPACE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, '');

// Alibaba Model Studio model used for chats and scheduled tasks and can read images
export const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen3.8-flash';

// Alibaba Model Studio model used for describing stickers 
export const STICKER_PROCESSING_MODEL = process.env.STICKER_PROCESSING_MODEL || CHAT_MODEL;
