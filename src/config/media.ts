import 'dotenv/config';

/**
 * Whether Sofia can view videos (`ENABLE_VIDEO=true`). Off by default: viewing a video downloads the whole file just to
 * show her its first frame. GIFs (short silent mp4s) can always be viewed.
 */
export const VIDEO_ENABLED = process.env.ENABLE_VIDEO?.trim().toLowerCase() == 'true';
