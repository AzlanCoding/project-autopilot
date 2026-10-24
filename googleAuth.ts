/**
 * Signs Sofia in to her Google Workspace account (sofia@nyp-gdg.com) and saves the token for the Workspace tools.
 *
 * Usage: pnpm google-auth [--check]
 *   Needs the Desktop OAuth client JSON at assets/workspace_client_secret.json (WORKSPACE_CLIENT_SECRET_PATH).
 *   Opens a sign-in link; sign in as Sofia. If the browser can't reach this machine (e.g. over SSH), paste the address
 *   it ends up on (http://127.0.0.1:.../?code=...) here instead.
 *   --check  Only tests the saved token: shows the account, its shared drives and their ids (for GDG_SHARED_DRIVE_ID).
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import readline from 'readline';
import { google } from 'googleapis';
import { WORKSPACE_CLIENT_SECRET_PATH, WORKSPACE_SCOPES, WORKSPACE_TOKEN_PATH } from './src/config/googleWorkspace';
import { GoogleWorkspace } from './src/services/googleWorkspace';

async function signIn() {
  if (!fs.existsSync(WORKSPACE_CLIENT_SECRET_PATH)) {
    throw Error(`Save the Desktop OAuth client JSON from Google Cloud as ${WORKSPACE_CLIENT_SECRET_PATH} first.`);
  }
  const secret = JSON.parse(fs.readFileSync(WORKSPACE_CLIENT_SECRET_PATH, 'utf8'));
  const { client_id, client_secret } = secret.installed ?? secret.web;

  // Desktop clients accept any loopback port as the redirect
  let resolveCode!: (code: string) => void;
  const codeReceived = new Promise<string>(resolve => resolveCode = resolve);
  const server = http.createServer((req, res) => {
    const code = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(code ? 'Sofia is signed in, you can close this tab.' : 'No code in this address.');
    if (code) resolveCode(code);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirectUri);
  const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: WORKSPACE_SCOPES, login_hint: 'sofia@nyp-gdg.com' });

  console.log(`\nSign in as sofia@nyp-gdg.com:\n\n${url}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Waiting for the sign-in... (or paste the address you were sent to and press Enter)\n', answer => {
    const code = (() => { try { return new URL(answer.trim()).searchParams.get('code'); } catch { return answer.trim(); } })();
    if (code) resolveCode(code);
  });
  const code = await codeReceived;
  rl.close();
  server.close();

  const { tokens } = await auth.getToken({ code, redirect_uri: redirectUri });
  if (!tokens.refresh_token) {
    throw Error('Google sent no refresh token. Remove Sofia\'s access at https://myaccount.google.com/permissions and run this again.');
  }
  fs.writeFileSync(WORKSPACE_TOKEN_PATH, JSON.stringify(tokens));
  console.log(`\nSaved the token to ${WORKSPACE_TOKEN_PATH}`);
}

async function check() {
  const auth = GoogleWorkspace.authClient() as any;
  const drive = google.drive({ version: 'v3', auth });
  const about = (await drive.about.get({ fields: 'user(displayName,emailAddress)' })).data;
  console.log(`\nSigned in as ${about.user?.displayName} <${about.user?.emailAddress}>`);
  const drives = (await drive.drives.list({ pageSize: 100 })).data.drives ?? [];
  console.log(drives.length
    ? `\nShared drives (set GDG_SHARED_DRIVE_ID to the club's):\n${drives.map(d => `  ${d.name}: ${d.id}`).join('\n')}`
    : '\nNo shared drives yet: add sofia@nyp-gdg.com to the club\'s shared drive as a Content manager.');
}

(async () => {
  if (!process.argv.includes('--check')) {
    await signIn();
  }
  await check();
})().catch(e => {
  console.error(`\n${e?.message ?? e}`);
  process.exit(1);
});
