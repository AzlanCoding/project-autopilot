import { OpenAI } from 'openai';
import { STICKER_PROCESSING_MODEL, MODELSTUDIO_BASE_URL } from '../config/modelStudio';
import { ModelImage, ModelVideo } from './media';

const openai = new OpenAI({ apiKey: process.env.ALIBABA_API_KEY, baseURL: MODELSTUDIO_BASE_URL });

/**
 * Writes a searchable description of a sticker or GIF with the vision model. The description is embedded with
 * text-embedding-v4 for `search_sticker_gif`, so it covers what it shows, any text in it, and when to send it.
 * GIFs can be given as a video so the model sees the whole animation. This uses Chat Completions, the Responses API
 * silently drops base64 `input_video` parts for the chat model.
 */
export async function describeStickerGif(media: ModelImage | ModelVideo, kind: 'sticker' | 'gif'): Promise<string> {
  const isVideo = 'videoUrl' in media;
  const note = isVideo ? ' (a short looping video, this is the whole animation)' : media.animated ? ' (animated, this is the first frame)' : '';
  const res = await openai.chat.completions.create({
    model: STICKER_PROCESSING_MODEL,
    messages: [{
      role: 'user',
      content: [
        // `video_url` is a Model Studio extension, not in the OpenAI SDK's types
        isVideo
          ? { type: 'video_url', video_url: { url: media.videoUrl } } as any
          : { type: 'image_url', image_url: { url: media.dataUrl, detail: 'auto' } },
        {
          type: 'text', text: `This is a WhatsApp ${kind == 'gif' ? 'GIF' : 'sticker'}${note}. Describe it so it can be found by searching. In 1-3 short sentences: what it shows, any text written on it (quoted exactly), and the emotion or reaction it expresses. Then a line "When to send:" with when someone would send it in a chat, and a line "Keywords:" with 5-10 comma separated keywords. Plain text only, no Markdown.`
        },
      ],
    }],
  });
  return res.choices[0].message.content?.trim() || '';
}
