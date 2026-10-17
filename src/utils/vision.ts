import { OpenAI } from 'openai';
import { CHAT_MODEL, MODELSTUDIO_BASE_URL } from '../config/modelStudio';
import { ModelImage } from './media';

const openai = new OpenAI({ apiKey: process.env.ALIBABA_API_KEY, baseURL: MODELSTUDIO_BASE_URL });

/**
 * Writes a searchable description of a sticker or GIF with the vision model. The description is embedded with
 * text-embedding-v4 for `search_sticker_gif`, so it covers what it shows, any text in it, and when to send it.
 */
export async function describeStickerGif(image: ModelImage, kind: 'sticker' | 'gif'): Promise<string> {
  const res = await openai.responses.create({
    model: CHAT_MODEL,
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text', text: `This is a WhatsApp ${kind == 'gif' ? 'GIF' : 'sticker'}${image.animated ? ' (animated, this is the first frame)' : ''}. Describe it so it can be found by searching. In 1-3 short sentences: what it shows, any text written on it (quoted exactly), and the emotion or reaction it expresses. Then a line "When to send:" with when someone would send it in a chat, and a line "Keywords:" with 5-10 comma separated keywords. Plain text only, no Markdown.`
        },
        { type: 'input_image', image_url: image.dataUrl, detail: 'auto' },
      ],
    }],
  });
  return res.output_text.trim();
}
