import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleUrl, googleFileLink } from '../src/utils/googleUrls';
import { columnLetter, docStructure, docTabLabel, docTabs, docToMarkdown, formatComments, parseA1Cell, sheetGrid, sheetTabs, slidesText, findSlide } from '../src/services/workspaceFormat';
import { isPrivateAddress, fetchPublic } from '../src/utils/safeFetch';
import { imageResultsFromOutput } from '../src/services/imageSearch';
import { GoogleWorkspace, MIME } from '../src/services/googleWorkspace';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

test('Google links of every shape give the file id, kind and tab', () => {
  assert.deepEqual(parseGoogleUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=123`), { id: ID, kind: 'spreadsheet', gid: 123 });
  assert.deepEqual(parseGoogleUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=0#gid=0`), { id: ID, kind: 'spreadsheet', gid: 0 });
  assert.deepEqual(parseGoogleUrl(`https://docs.google.com/document/d/${ID}/edit?tab=t.abc123`), { id: ID, kind: 'document', tabId: 't.abc123' });
  assert.deepEqual(parseGoogleUrl(`https://docs.google.com/document/u/1/d/${ID}/edit`), { id: ID, kind: 'document' });
  assert.deepEqual(parseGoogleUrl(`https://docs.google.com/presentation/d/${ID}/edit#slide=id.g2f3a4b5c6d_0_12`), { id: ID, kind: 'presentation', slideId: 'g2f3a4b5c6d_0_12' });
  assert.deepEqual(parseGoogleUrl(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), { id: ID, kind: 'file' });
  assert.deepEqual(parseGoogleUrl(`https://drive.google.com/drive/folders/${ID}`), { id: ID, kind: 'folder' });
  assert.deepEqual(parseGoogleUrl(`https://drive.google.com/drive/u/0/folders/${ID}`), { id: ID, kind: 'folder' });
  assert.deepEqual(parseGoogleUrl(`https://drive.google.com/open?id=${ID}`), { id: ID, kind: 'unknown' });
  assert.deepEqual(parseGoogleUrl(ID), { id: ID, kind: 'unknown' });
  assert.throws(() => parseGoogleUrl('https://example.com/file.pdf'), /isn't a Google link/);
  assert.throws(() => parseGoogleUrl('the budget sheet'), /isn't a Google Docs, Sheets, Slides or Drive link/);
  assert.equal(googleFileLink(ID, MIME.sheet), `https://docs.google.com/spreadsheets/d/${ID}/edit`);
});

/** A Doc with two tabs: a proposal with a heading, a list, a link and a 2x3 budget table, and an empty notes tab. */
const proposalDoc = {
  title: 'DevFest Proposal',
  tabs: [{
    tabProperties: { tabId: 't.0', title: 'Proposal' },
    documentTab: {
      body: {
        content: [
          { startIndex: 0, endIndex: 1, sectionBreak: {} },
          { startIndex: 1, endIndex: 17, paragraph: { paragraphStyle: { namedStyleType: 'HEADING_1' }, elements: [{ startIndex: 1, endIndex: 17, textRun: { content: 'DevFest Proposal\n' } }] } },
          { startIndex: 17, endIndex: 30, paragraph: { bullet: { listId: 'l1' }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ startIndex: 17, endIndex: 30, textRun: { content: 'Venue: NYP L\n' } }] } },
          {
            startIndex: 30, endIndex: 45, paragraph: {
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [
                { startIndex: 30, endIndex: 34, textRun: { content: 'See ' } },
                { startIndex: 34, endIndex: 44, textRun: { content: 'the guide', textStyle: { link: { url: 'https://example.com/guide' } } } },
                { startIndex: 44, endIndex: 45, textRun: { content: '\n' } },
              ],
            },
          },
          {
            startIndex: 45, endIndex: 80, table: {
              rows: 2, columns: 3, tableRows: [
                { tableCells: [cell(46, 'Item'), cell(52, 'Cost'), cell(58, 'Notes')] },
                { tableCells: [cell(65, 'Snacks'), cell(73, '120'), cell(78, '')] },
              ],
            },
          },
          { startIndex: 80, endIndex: 82, paragraph: { elements: [{ startIndex: 80, endIndex: 81, inlineObjectElement: { inlineObjectId: 'kix.logo' } }, { startIndex: 81, endIndex: 82, textRun: { content: '\n' } }] } },
        ],
      },
      inlineObjects: { 'kix.logo': { inlineObjectProperties: { embeddedObject: { size: { width: { magnitude: 120 }, height: { magnitude: 40 } } } } } },
    },
    childTabs: [{ tabProperties: { tabId: 't.1', title: 'Notes' }, documentTab: { body: { content: [] } } }],
  }],
};
function cell(start: number, text: string) {
  return { startIndex: start - 1, content: [{ startIndex: start, paragraph: { elements: [{ startIndex: start, textRun: { content: `${text}\n` } }] } }] };
}

test('Docs read as Markdown and as a structure with indices, tabs included', () => {
  const tabs = docTabs(proposalDoc as any);
  assert.deepEqual(tabs.map(t => [t.id, t.title, t.level]), [['t.0', 'Proposal', 0], ['t.1', 'Notes', 1]]);
  // Tabs inside other tabs say so, otherwise a list of tabs looks flat
  assert.equal(docTabLabel(tabs[1]), '"Notes" (id t.1, inside "Proposal")');
  assert.equal(docToMarkdown(tabs[0].body), [
    '# DevFest Proposal', '', '- Venue: NYP L', 'See [the guide](https://example.com/guide)', '',
    '| Item | Cost | Notes |', '| --- | --- | --- |', '| Snacks | 120 |  |', '', '[image]',
  ].join('\n'));
  assert.equal(docStructure(tabs[0].body, tabs[0].inlineObjects), [
    '[1-17] HEADING_1 "DevFest Proposal"',
    '[17-30] BULLET "Venue: NYP L"',
    '[30-45] P "See the guide"',
    '[45-80] TABLE 1 (2 rows x 3 columns)',
    '  row 1: c1@46 "Item" | c2@52 "Cost" | c3@58 "Notes"',
    '  row 2: c1@65 "Snacks" | c2@73 "120" | c3@78 ""',
    '[80] IMAGE kix.logo 120x40pt',
  ].join('\n'));
});

test('Sheets show tabs, a grid with column letters, merged cells and formulas', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(27), 'AB');
  assert.deepEqual(parseA1Cell('AB12'), { row: 11, col: 27 });
  const merges = [{ startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 }];
  assert.equal(sheetGrid([['Budget'], ['Item', 'Qty', 'Cost'], ['Snacks', '10', '120']], 0, 0, merges, [['Budget'], ['Item', 'Qty', 'Cost'], ['Snacks', '10', '=B3*12']]), [
    '| | A | B | C |', '|---|---|---|---|',
    '| 1 | Budget | <merged> | <merged> |',
    '| 2 | Item | Qty | Cost |',
    '| 3 | Snacks | 10 | 120 (=B3*12) |',
    '', 'Merged cells: A1:C1',
  ].join('\n'));
  // A block that starts at B5 only shows merges touching it
  assert.equal(sheetGrid([['x']], 4, 1, merges), '| | B |\n|---|---|\n| 5 | x |');
  assert.equal(sheetGrid([], 0, 0), '(empty)');
  assert.equal(sheetTabs({
    sheets: [
      { properties: { sheetId: 0, title: 'Budget', gridProperties: { rowCount: 100, columnCount: 26, frozenRowCount: 2 } }, merges },
      { properties: { sheetId: 42, title: 'Logistics', gridProperties: { rowCount: 50, columnCount: 10 } } },
      { properties: { sheetId: 7, title: 'Old', hidden: true, gridProperties: { rowCount: 10, columnCount: 5 } } },
    ],
  }), [
    '1. "Budget" (id 0, 100 rows x 26 columns, 2 frozen rows, 1 merged range)',
    '2. "Logistics" (id 42, 50 rows x 10 columns)',
    '3. "Old" (id 7, 10 rows x 5 columns, hidden)',
  ].join('\n'));
});

const EMU = 12700;
const deck = {
  pageSize: { width: { magnitude: 720 * EMU }, height: { magnitude: 405 * EMU } },
  layouts: [{ objectId: 'layout1', layoutProperties: { displayName: 'Title and body' } }],
  slides: [
    {
      objectId: 'slide1', slideProperties: {
        layoutObjectId: 'layout1',
        notesPage: { notesProperties: { speakerNotesObjectId: 'notes1' }, pageElements: [{ objectId: 'notes1', shape: { text: { textElements: [{ textRun: { content: 'Thank the sponsors\n' } }] } } }] },
      },
      pageElements: [
        { objectId: 'title1', size: { width: { magnitude: 3000000, unit: 'EMU' }, height: { magnitude: 500000, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: 381000, translateY: 254000, unit: 'EMU' }, shape: { shapeType: 'TEXT_BOX', placeholder: { type: 'TITLE' }, text: { textElements: [{ textRun: { content: 'DevFest 2026\n' } }] } } },
        { objectId: 'logo1', size: { width: { magnitude: 1270000, unit: 'EMU' }, height: { magnitude: 635000, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: 'EMU' }, image: { contentUrl: 'https://lh3.example/abc' }, title: 'GDG logo' },
        { objectId: 'table1', size: { width: { magnitude: 6350000, unit: 'EMU' }, height: { magnitude: 1270000, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, unit: 'EMU' }, table: { rows: 2, columns: 2, tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: 'Time\n' } }] } }, { text: { textElements: [{ textRun: { content: 'Talk\n' } }] } }] }, { tableCells: [{ text: { textElements: [{ textRun: { content: '10:00\n' } }] } }, { text: {} }] }] } },
      ],
    },
    { objectId: 'slide2', pageElements: [] },
  ],
};

test('Slides read as text with notes, and in detail with element ids, positions and table cells', () => {
  assert.equal(slidesText(deck as any), [
    'Slide 1 (id slide1, layout "Title and body")', 'DevFest 2026', '[image]', '| Time | Talk |\n| 10:00 |  |', 'Speaker notes: Thank the sponsors',
    '', 'Slide 2 (id slide2)',
  ].join('\n'));
  assert.equal(slidesText(deck as any, { detail: true, only: 1 }), [
    'Slide size 720x405pt', '',
    'Slide 1 (id slide1, layout "Title and body")',
    '- title1 SHAPE TEXT_BOX placeholder TITLE at 30,20 size 236x39pt: "DevFest 2026"',
    '- logo1 IMAGE at 0,0 size 100x50pt: "GDG logo"',
    '- table1 TABLE 2 rows x 2 columns at 0,0 size 500x100pt',
    '    row 1: "Time" | "Talk"',
    '    row 2: "10:00" | ""',
    'Speaker notes: Thank the sponsors',
  ].join('\n'));
  assert.equal(findSlide(deck as any, '2').slide.objectId, 'slide2');
  assert.equal(findSlide(deck as any, 'slide1').number, 1);
  assert.throws(() => findSlide(deck as any, 3), /no slide 3, the deck has 2 slides/);
});

test('comments show who, what they comment on, replies and resolved', () => {
  const text = formatComments([
    { id: 'c1', author: { displayName: 'Azlan' }, createdTime: '2026-10-24T08:00:00Z', content: 'Budget too low?', quotedFileContent: { value: '500 SGD' }, replies: [{ author: { displayName: 'Mary' }, content: 'Agreed' }, { deleted: true, content: 'x' }] },
    { id: 'c2', author: { displayName: 'John' }, content: 'Fixed', resolved: true },
  ], () => '24/10/2026');
  assert.equal(text, 'Comment c1 by Azlan (24/10/2026)\n  On: "500 SGD"\n  Budget too low?\n  Reply by Mary: Agreed\n\nComment c2 by John () [resolved]\n  Fixed');
  assert.equal(formatComments([], String), 'No comments.');
});

test('private and local addresses are refused before downloading', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '142.250.4.100', '2404:6800:4003:c00::64']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  await assert.rejects(fetchPublic('http://127.0.0.1:19530/'), /private or local address/);
  await assert.rejects(fetchPublic('http://localhost:3000/api/users'), /private or local address/);
  await assert.rejects(fetchPublic('file:///etc/passwd'), /Only http and https/);
});

test('image search results come from the tool output, without duplicates', () => {
  const results = imageResultsFromOutput([
    { type: 'reasoning' },
    { type: 'web_search_image_call', output: JSON.stringify([{ title: 'GDG logo', url: 'https://img.example/a.png', index: 1 }, { title: 'dup', url: 'https://img.example/a.png' }, { title: 'bad', url: 'javascript:alert(1)' }]) },
    { type: 'web_search_image_call', output: 'not json' },
    { type: 'web_search_image_call', output: JSON.stringify([{ title: ' Confetti GIF ', url: 'https://img.example/b.gif' }]) },
    { type: 'message', content: [] },
  ]);
  assert.deepEqual(results, [{ title: 'GDG logo', url: 'https://img.example/a.png' }, { title: 'Confetti GIF', url: 'https://img.example/b.gif' }]);
});

/** Fake API clients that record calls. */
function fakeClients(files: { [id: string]: any }) {
  const calls: string[] = [];
  const clients: any = {
    drive: {
      files: {
        get: async ({ fileId }: any) => {
          calls.push(`files.get ${fileId}`);
          if (!files[fileId]) throw Object.assign(new Error('File not found'), { code: 404 });
          return { data: files[fileId] };
        },
        copy: async ({ fileId, requestBody }: any) => {
          calls.push(`files.copy ${fileId} -> ${requestBody.mimeType} in ${requestBody.parents}`);
          return { data: { id: 'copy1' } };
        },
        delete: async ({ fileId }: any) => { calls.push(`files.delete ${fileId}`); return { data: {} }; },
      },
    },
    docs: { documents: { get: async ({ documentId }: any) => { calls.push(`docs.get ${documentId}`); return { data: proposalDoc }; } } },
  };
  return { clients, calls };
}

test('reading a .docx makes, reads and deletes a temporary copy; missing files say how to share them', async () => {
  const id = 'docx1docx1docx1docx1docx1';
  const { clients, calls } = fakeClients({ [id]: { id, name: 'Proposal.docx', mimeType: MIME.docx, webViewLink: `https://drive.google.com/file/d/${id}/view` } });
  const ws = new GoogleWorkspace(undefined, clients);
  const { text } = await ws.readFile(id);
  assert.match(text!, /^\(Read through a temporary Google copy, the original Word \(\.docx\) file is unchanged\.\)\n\n===== Tab "Proposal"/);
  assert.deepEqual(calls, [`files.get ${id}`, `files.copy ${id} -> ${MIME.doc} in root`, 'docs.get copy1', 'files.delete copy1']);
  await assert.rejects(ws.getFile('missingmissingmissingmissing'), /can't find that file.*share it with that account/);
});

/** Replaces fetch with redirects from `routes` (url -> next url, or null for a normal page), recording each request. */
function stubRedirects(routes: { [url: string]: string | null }) {
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    requested.push(`${init?.method ?? 'GET'} ${url}`);
    const next = routes[url];
    return next ? new Response(null, { status: 301, headers: { location: next } }) : new Response('page', { status: 200 });
  }) as any;
  return { requested, restore: () => { globalThis.fetch = original; } };
}

test('short links are followed to the Google file they lead to, without opening Google itself or private addresses', async () => {
  const { resolveLink } = await import('../src/utils/safeFetch');
  const { toGoogleLink, isDriveId } = await import('../src/utils/googleUrls');
  const doc = `https://docs.google.com/document/d/${ID}/edit`;
  const stub = stubRedirects({ 'http://93.184.216.34/gdgoc-plan': 'http://93.184.216.35/r/abc', 'http://93.184.216.35/r/abc': doc, 'http://93.184.216.34/to-private': 'http://192.168.1.10/admin' });
  try {
    assert.equal(await toGoogleLink('http://93.184.216.34/gdgoc-plan'), doc);
    assert.deepEqual(stub.requested, ['HEAD http://93.184.216.34/gdgoc-plan', 'HEAD http://93.184.216.35/r/abc']); // stops at Google, doesn't fetch it
    assert.equal(await toGoogleLink('http://93.184.216.34/just-a-page'), null);
    await assert.rejects(resolveLink('http://93.184.216.34/to-private'), /192\.168\.1\.10 is a private or local address/);
  }
  finally {
    stub.restore();
  }
  assert.equal(await toGoogleLink(ID), ID);
  assert.equal(isDriveId('ACE0B927961B819070F42E49AD5E07AD'), false, 'WhatsApp media ids are not Drive ids');
  assert.equal(await toGoogleLink('ACE0B927961B819070F42E49AD5E07AD'), null);
});

test('Drive shortcuts open their target, from a link or a short link, and listings say what they point to', async () => {
  const target = 'targettargettargettargetdoc';
  const shortcut = 'shortcutshortcutshortcutid1';
  const { clients } = fakeClients({
    [shortcut]: { id: shortcut, name: 'Proposal (shortcut)', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: target, targetMimeType: MIME.doc } },
    [target]: { id: target, name: 'Proposal', mimeType: MIME.doc, webViewLink: `https://docs.google.com/document/d/${target}/edit` },
  });
  const ws = new GoogleWorkspace(undefined, clients);
  assert.equal((await ws.getFile(`https://drive.google.com/file/d/${shortcut}/view`)).name, 'Proposal');
  const stub = stubRedirects({ 'http://93.184.216.34/s': `https://drive.google.com/file/d/${shortcut}/view` });
  try {
    assert.equal((await ws.getFile('http://93.184.216.34/s')).id, target);
    await assert.rejects(ws.getFile('http://93.184.216.34/elsewhere'), /doesn't lead to a Google Docs, Sheets, Slides or Drive file/);
  }
  finally {
    stub.restore();
  }
  const { driveFileLine } = await import('../src/services/workspaceFormat');
  assert.equal(driveFileLine({ name: 'Proposal (shortcut)', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetMimeType: MIME.doc }, webViewLink: 'https://drive/x' }, String),
    '- "Proposal (shortcut)" (Shortcut to Google Doc) https://drive/x');
});
