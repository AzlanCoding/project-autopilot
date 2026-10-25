import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import { applyTextEdits, createDriveFileTool, fetchRawText, isTextFile, numberLines, rawGithubUrl, searchLines, textMimeFor } from '../src/services/textFileTools';
import { GoogleWorkspace } from '../src/services/googleWorkspace';

test('find-and-replace edits must match exactly once (or replace_all), applied in order, all or nothing', () => {
  const md = '# Agenda\n- Intro\n- Talk\n- Talk Q&A\n';
  assert.deepEqual(applyTextEdits(md, [{ old: '- Intro', new: '- Welcome' }, { old: 'Talk Q&A', new: 'Q&A' }]), { text: '# Agenda\n- Welcome\n- Talk\n- Q&A\n', replaced: 2 });
  assert.throws(() => applyTextEdits(md, [{ old: 'Talk', new: 'Session' }]), /appears 2 times\. Include more of the surrounding text/);
  assert.deepEqual(applyTextEdits(md, [{ old: 'Talk', new: 'Session', replace_all: true }]).replaced, 2);
  assert.throws(() => applyTextEdits(md, [{ old: '- Intro', new: '- Welcome' }, { old: 'Lunch', new: 'Dinner' }]), /Edit 2: the text to replace wasn't found/);
  assert.throws(() => applyTextEdits(md, [{ old: '', new: 'x' }]), /old is empty/);
});

test('reads show numbered lines a window at a time, and search finds lines', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  assert.equal(numberLines(text, 3, 2), '    3  line 3\n    4  line 4\n[Lines 3-4 of 10. Read more with offset 5.]');
  assert.match(numberLines(text), /\[Lines 1-10 of 10\.\]$/);
  // Very long lines stop at the character cap, still showing at least one line
  const long = Array.from({ length: 3 }, () => 'x'.repeat(30000)).join('\n');
  assert.match(numberLines(long), /\[Lines 1-1 of 3\. Read more with offset 2\.\]$/);
  assert.equal(searchLines(text, 'LINE 1'), '    1  line 1\n   10  line 10');
});

test('file types and GitHub links', () => {
  assert.equal(textMimeFor('agenda.md'), 'text/markdown');
  assert.equal(textMimeFor('data.JSON'), 'application/json');
  assert.equal(textMimeFor('notes'), 'text/plain');
  assert.equal(isTextFile('text/csv'), true);
  assert.equal(isTextFile('application/octet-stream', 'spec.md'), true);
  assert.equal(isTextFile('application/octet-stream', 'photo.png'), false);
  assert.equal(isTextFile('application/pdf', 'a.pdf'), false);
  assert.equal(rawGithubUrl('https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md'), 'https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/SPEC.md');
  assert.equal(rawGithubUrl('https://example.com/a.md'), 'https://example.com/a.md');
});

test('fetch_url returns raw text up to the limit and says where to continue; non-text is refused', async () => {
  const original = globalThis.fetch;
  const body = 'a'.repeat(25000) + 'END';
  globalThis.fetch = (async (url: any) => String(url).endsWith('.png')
    ? new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), { headers: { 'content-type': 'image/png' } })
    : new Response(body, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })) as any;
  try {
    const first = await fetchRawText('http://93.184.216.34/SPEC.md');
    assert.match(first, /^http:\/\/93\.184\.216\.34\/SPEC\.md \(text\/markdown, 25003 characters\)\n\na{20000}\n\n\[Characters 0-20000 of 25003\. Read more with start 20000\.\]$/);
    assert.match(await fetchRawText('http://93.184.216.34/SPEC.md', { start: 20000 }), /a{5000}END\n\n\[Characters 20000-25003 of 25003, the end\.\]$/);
    await assert.rejects(fetchRawText('http://93.184.216.34/logo.png'), /isn't a text file \(image\/png\)/);
  }
  finally {
    globalThis.fetch = original;
  }
});

test('drive_file edits only files read first and unchanged since, and saves the edited text', async () => {
  let content = '# Plan\n- Venue: TBC\n';
  let modified = '2026-10-25T00:00:00Z';
  const updates: string[] = [];
  const file = { id: 'mdfile0000000000000000000a', name: 'plan.md', mimeType: 'text/markdown', webViewLink: 'https://drive/plan' };
  const clients: any = {
    drive: {
      files: {
        get: async ({ alt }: any) => ({ data: alt == 'media' ? Buffer.from(content) : { ...file, modifiedTime: modified } }),
        update: async ({ media }: any) => {
          const chunks: Buffer[] = [];
          for await (const c of media.body as Readable) chunks.push(Buffer.from(c));
          content = Buffer.concat(chunks).toString('utf8');
          updates.push(content);
          modified = `2026-10-25T00:00:0${updates.length}Z`;
          return { data: { ...file, modifiedTime: modified } };
        },
      },
    },
  };
  const tool = createDriveFileTool(new GoogleWorkspace(undefined, clients));
  await assert.rejects(tool.invoke({ action: 'edit', url: file.id, edits: [{ old: 'TBC', new: 'L456' }] }), /Read "plan\.md" with drive_file read first/);
  assert.match(await tool.invoke({ action: 'read', url: file.id }) as string, /    2  - Venue: TBC/);
  assert.equal(await tool.invoke({ action: 'edit', url: file.id, edits: [{ old: 'TBC', new: 'L456' }] }), 'Edited "plan.md": 1 replacement.');
  assert.equal(content, '# Plan\n- Venue: L456\n');
  // Her own edit doesn't count as someone else's change
  await tool.invoke({ action: 'append', url: file.id, content: '- Date: 21 Nov' });
  assert.equal(content, '# Plan\n- Venue: L456\n- Date: 21 Nov');
  // Someone else edits it
  modified = '2026-10-25T09:00:00Z';
  await assert.rejects(tool.invoke({ action: 'edit', url: file.id, edits: [{ old: 'L456', new: 'L457' }] }), /changed since you read it/);
});
