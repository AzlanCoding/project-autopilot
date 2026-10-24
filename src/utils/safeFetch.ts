import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Downloads a public URL (e.g. an image Sofia found). The bot runs with host networking next to Postgres, Milvus and the
 * web UI, so URLs that point at the machine itself or a private network are refused, including after redirects.
 */

const MAX_REDIRECTS = 3;

/** Whether an IP address is loopback, private, link-local or otherwise not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) == 4) {
    const [a, b] = ip.split('.').map(Number);
    return a == 0 || a == 10 || a == 127 || (a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254) ||
      (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 198 && (b == 18 || b == 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) {
    return isPrivateAddress(v6.slice(7));
  }
  return v6 == '::' || v6 == '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

async function checkUrl(url: URL) {
  if (url.protocol != 'https:' && url.protocol != 'http:') {
    throw Error(`Only http and https links can be opened, not ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (addresses.length == 0) {
    throw Error(`Couldn't find the website ${url.hostname}.`);
  }
  if (host == 'localhost' || addresses.some(isPrivateAddress)) {
    throw Error(`${url.hostname} is a private or local address, only public links can be opened.`);
  }
}

/** Downloads `input` (following up to 3 redirects, each checked) and returns its bytes and content type. */
export async function fetchPublic(input: string, { maxBytes = 20 * 1024 * 1024, timeoutMs = 20000 } = {}): Promise<{ buffer: Buffer, contentType: string, url: string }> {
  let url: URL;
  try {
    url = new URL(input.trim());
  }
  catch {
    throw Error(`"${input}" isn't a link.`);
  }
  for (let i = 0; ; i++) {
    await checkUrl(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SofiaBot/1.0)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (i >= MAX_REDIRECTS) throw Error(`${input} redirects too many times.`);
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) {
      throw Error(`Couldn't download ${input} (HTTP ${res.status}).`);
    }
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
      throw Error(`${input} is too big (over ${Math.round(maxBytes / 1024 / 1024)} MB).`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw Error(`${input} is too big (over ${Math.round(maxBytes / 1024 / 1024)} MB).`);
    }
    return { buffer, contentType: res.headers.get('content-type')?.split(';')[0].trim() ?? '', url: url.toString() };
  }
}

/**
 * Follows a link's redirects (e.g. a short link like goo.gle/...) without downloading the page, and returns where it
 * ends up, or the first address `stop` accepts. Every hop is checked like `fetchPublic`.
 */
export async function resolveLink(input: string, { stop, maxHops = 6, timeoutMs = 15000 }: { stop?: (url: URL) => boolean, maxHops?: number, timeoutMs?: number } = {}): Promise<string> {
  let url: URL;
  try {
    url = new URL(input.trim());
  }
  catch {
    throw Error(`"${input}" isn't a link.`);
  }
  for (let i = 0; i <= maxHops; i++) {
    if (stop?.(url)) {
      return url.toString();
    }
    await checkUrl(url);
    const request = (method: string) => fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SofiaBot/1.0)' } });
    // Some shorteners don't answer HEAD, so fall back to GET (its body is never read)
    let res = await request('HEAD').catch(() => undefined);
    if (!res || res.status == 405 || res.status == 403 || res.status == 404 || (res.status >= 500)) {
      res = await request('GET');
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    await res.body?.cancel().catch(() => undefined);
    if (!location) {
      return url.toString();
    }
    url = new URL(location, url);
  }
  throw Error(`${input} redirects too many times.`);
}
