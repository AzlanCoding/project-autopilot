import 'dotenv/config';
import * as fs from 'fs';

/**
 * Sofia's Google Workspace account (`sofia@nyp-gdg.com`) for Drive, Docs, Sheets, Slides and the directory. Signed in once
 * with `pnpm google-auth`, which saves the token below. The Workspace tools are only added when the token exists.
 */
export const WORKSPACE_CLIENT_SECRET_PATH = process.env.WORKSPACE_CLIENT_SECRET_PATH || './assets/workspace_client_secret.json';
export const WORKSPACE_TOKEN_PATH = process.env.WORKSPACE_TOKEN_PATH || './assets/google-workspace-token.json';
export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/drive', // Drive, Docs, Sheets and Slides
  'https://www.googleapis.com/auth/directory.readonly', // People in the organisation's directory
];
export const WORKSPACE_ENABLED = fs.existsSync(WORKSPACE_TOKEN_PATH) && fs.existsSync(WORKSPACE_CLIENT_SECRET_PATH);

/** The GDG on Campus shared drive, where new files go unless a folder is given (`pnpm google-auth` lists the ids). */
export const GDG_SHARED_DRIVE_ID = process.env.GDG_SHARED_DRIVE_ID?.trim() || undefined;

/** Model used for image search (`web_search_image`), which DeepSeek models don't support. */
export const IMAGE_SEARCH_MODEL = process.env.IMAGE_SEARCH_MODEL || 'qwen3.8-flash';
