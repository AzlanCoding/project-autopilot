import { test } from 'node:test';
const last = <T>(list: T[]): T => list[list.length - 1];
import assert from 'node:assert/strict';
import {
  a1ToGridRange, docTableCellRequests, hexColor, imageFormula, markdownToDocsRequests, parseInlineMarkdown, parseMarkdownBlocks,
  parseRequests, sheetFormatRequest, slideSetTextRequests,
} from '../src/services/workspaceEdit';
import { GoogleWorkspace, MIME } from '../src/services/googleWorkspace';
import { createWorkspaceWriteTools } from '../src/services/workspaceWriteTools';

test('inline Markdown becomes plain text with bold, italic and link spans', () => {
  assert.deepEqual(parseInlineMarkdown('Total **$500** for *snacks* (see [the sheet](https://example.com/s)) and_not_italic'), {
    text: 'Total $500 for snacks (see the sheet) and_not_italic',
    spans: [{ start: 6, end: 10, bold: true }, { start: 15, end: 21, italic: true }, { start: 27, end: 36, link: 'https://example.com/s' }],
  });
  assert.deepEqual(parseMarkdownBlocks('# Plan\n\n- Venue\n  - Room L.532\n1. Book room\nDone'), [
    { text: 'Plan', spans: [], heading: 1, level: 0 },
    { text: 'Venue', spans: [], bullet: 'BULLET', level: 0 },
    { text: 'Room L.532', spans: [], bullet: 'BULLET', level: 1 },
    { text: 'Book room', spans: [], bullet: 'NUMBERED', level: 0 },
    { text: 'Done', spans: [], level: 0 },
  ]);
});

test('Markdown appended at the end of a Doc goes after the last paragraph, styled, with bullets last and nested by tabs', () => {
  const requests = markdownToDocsRequests('## Budget\n- Snacks **$120**\n  - Chips\nThanks', 50, 'end', 't.1');
  // Inserted before the body's final newline, starting with a newline so it's a new paragraph
  assert.deepEqual(requests[0], { insertText: { location: { index: 49, tabId: 't.1' }, text: '\nBudget\nSnacks $120\n\tChips\nThanks' } });
  const types = requests.map(r => Object.keys(r)[0]);
  assert.deepEqual(types, ['insertText', 'updateParagraphStyle', 'deleteParagraphBullets', 'updateTextStyle', 'updateParagraphStyle', 'updateTextStyle', 'createParagraphBullets']);
  // Heading 2 covers "Budget\n" (50-57), bold covers "$120" (64-68), one bullet group covers both list items (57-77)
  assert.deepEqual(requests[4], { updateParagraphStyle: { range: { startIndex: 50, endIndex: 57, tabId: 't.1' }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } });
  assert.deepEqual(requests[5], { updateTextStyle: { range: { startIndex: 64, endIndex: 68, tabId: 't.1' }, textStyle: { bold: true }, fields: 'bold' } });
  assert.deepEqual(requests[6], { createParagraphBullets: { range: { startIndex: 57, endIndex: 76, tabId: 't.1' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
});

test('Markdown inserted at a paragraph start goes before that paragraph', () => {
  const requests = markdownToDocsRequests('Intro\n1. First\n2. Second', 10, 'paragraph');
  assert.deepEqual(requests[0], { insertText: { location: { index: 10 }, text: 'Intro\nFirst\nSecond\n' } });
  assert.deepEqual(last(requests), { createParagraphBullets: { range: { startIndex: 16, endIndex: 29 }, bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } });
  assert.deepEqual(markdownToDocsRequests('\n\n', 10, 'paragraph'), []);
});

const cell = (start: number, text: string) => ({ startIndex: start - 1, content: [{ startIndex: start, endIndex: start + text.length + 1, paragraph: {} }] });

test('Doc table cells are edited from the last cell backwards so indices stay valid', () => {
  const table = { rows: 2, columns: 2, tableRows: [{ tableCells: [cell(10, 'Item'), cell(16, 'Cost')] }, { tableCells: [cell(22, 'Snacks'), cell(30, '')] }] };
  assert.deepEqual(docTableCellRequests(table as any, [{ row: 1, col: 2, text: 'Price' }, { row: 2, col: 2, text: '120' }, { row: 2, col: 1, text: '' }]), [
    { insertText: { location: { index: 30 }, text: '120' } }, // empty cell: nothing to delete
    { deleteContentRange: { range: { startIndex: 22, endIndex: 28 } } }, // cleared, nothing inserted
    { deleteContentRange: { range: { startIndex: 16, endIndex: 20 } } },
    { insertText: { location: { index: 16 }, text: 'Price' } },
  ]);
  assert.throws(() => docTableCellRequests(table as any, [{ row: 3, col: 1, text: 'x' }]), /no cell at row 3, column 1 \(it has 2 rows and 2 columns\)/);
});

test('Sheets ranges, colours, formats and images', () => {
  assert.deepEqual(a1ToGridRange('B2:D5', 7), { sheetId: 7, startRowIndex: 1, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 4 });
  assert.deepEqual(a1ToGridRange("'Budget'!A1", 0), { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 });
  assert.deepEqual(a1ToGridRange('A:C', 0), { sheetId: 0, startColumnIndex: 0, endColumnIndex: 3 });
  assert.deepEqual(a1ToGridRange('2:4', 0), { sheetId: 0, startRowIndex: 1, endRowIndex: 4 });
  assert.deepEqual(hexColor('#4285F4'), { red: 0x42 / 255, green: 0x85 / 255, blue: 0xF4 / 255 });
  assert.throws(() => hexColor('blue'), /isn't a colour/);
  const format = sheetFormatRequest({ sheetId: 0 }, { bold: true, background: '#000000', align: 'CENTER' });
  assert.equal(format.repeatCell?.fields, 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor,userEnteredFormat.horizontalAlignment');
  assert.throws(() => sheetFormatRequest({ sheetId: 0 }, {}), /at least one format/);
  assert.equal(imageFormula('https://img.example/a "b".png'), '=IMAGE("https://img.example/a ""b"".png")');
});

test('Slides text is replaced by deleting the old text first, and raw requests are checked', () => {
  assert.deepEqual(slideSetTextRequests('table1', 'Talk', true, { row: 2, col: 3 }), [
    { deleteText: { objectId: 'table1', cellLocation: { rowIndex: 1, columnIndex: 2 }, textRange: { type: 'ALL' } } },
    { insertText: { objectId: 'table1', cellLocation: { rowIndex: 1, columnIndex: 2 }, insertionIndex: 0, text: 'Talk' } },
  ]);
  assert.deepEqual(slideSetTextRequests('box', 'Hi', false), [{ insertText: { objectId: 'box', insertionIndex: 0, text: 'Hi' } }]);
  assert.deepEqual(parseRequests('{"requests": [{"deleteObject": {"objectId": "x"}}]}'), [{ deleteObject: { objectId: 'x' } }]);
  assert.throws(() => parseRequests('[{"a": 1},'), /isn't valid JSON/);
  assert.throws(() => parseRequests('[]'), /must be a JSON array of request objects/);
});

/** A GoogleWorkspace with fake clients for `files` (by id), recording calls. Sofia is sofia@nyp-gdg.com. */
function workspace(files: { [id: string]: any }, overrides: any = {}) {
  const calls: string[] = [];
  const record = (name: string, result: any = {}) => async (params: any) => { calls.push(`${name} ${JSON.stringify(params, (k, v) => k == 'body' ? '<body>' : v)}`); return { data: typeof result == 'function' ? result(params) : result }; };
  const clients: any = {
    drive: {
      about: { get: record('about.get', { user: { emailAddress: 'sofia@nyp-gdg.com' } }) },
      files: {
        get: async ({ fileId }: any) => {
          if (!files[fileId]) throw Object.assign(new Error('not found'), { code: 404 });
          return { data: files[fileId] };
        },
        update: record('files.update', (p: any) => ({ id: p.fileId, name: files[p.fileId]?.name, mimeType: files[p.fileId]?.mimeType })),
        copy: record('files.copy', { id: 'copy1', name: 'Copy', mimeType: MIME.doc, webViewLink: 'https://docs.google.com/document/d/copy1/edit' }),
        create: record('files.create', { id: 'upload1' }),
        delete: record('files.delete'),
      },
      permissions: {
        list: record('permissions.list', { permissions: overrides.permissions ?? [] }),
        create: record('permissions.create', { id: 'perm1' }),
        update: record('permissions.update'),
        delete: record('permissions.delete'),
      },
    },
    slides: overrides.slides,
    sheets: overrides.sheets,
    docs: {
      documents: {
        get: async () => ({ data: { tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 7, paragraph: { elements: [{ textRun: { content: 'Hello\n' } }] } }] } } }] } }),
        batchUpdate: overrides.docsBatchUpdate ?? record('docs.batchUpdate', { replies: [] }),
      },
    },
  };
  const ws = new GoogleWorkspace(undefined, clients);
  const tools = Object.fromEntries(createWorkspaceWriteTools(ws, {
    getChatMedia: async () => ({ buffer: Buffer.from('png'), mime: 'image/png', kind: 'image' }),
    getImage: (id: string) => { if (id != 'img_1') throw Error(`${id} isn't available any more`); return { buffer: Buffer.from('generated'), mime: 'image/png' }; },
  }).map(t => [t.name, t]));
  return { tools, calls };
}

const LONG = (s: string) => s.padEnd(28, '0');
const mine = { id: LONG('mine'), name: 'Budget', mimeType: MIME.sheet, owners: [{ emailAddress: 'sofia@nyp-gdg.com', displayName: 'Sofia' }], webViewLink: 'https://docs.google.com/spreadsheets/d/mine/edit' };
const theirs = { ...mine, id: LONG('theirs'), owners: [{ emailAddress: 'azlan@nyp-gdg.com', displayName: 'Azlan' }] };
const inSharedDrive = { ...mine, id: LONG('shared'), driveId: 'drive1', owners: undefined };

test('ownership transfers: immediate inside the domain, pending outside, refused for shared drive files and other owners', async () => {
  let { tools, calls } = workspace({ [mine.id]: mine });
  assert.match(await tools.drive_share.invoke({ action: 'transfer_ownership', url: mine.id, email: 'azlan@nyp-gdg.com' }) as string, /azlan@nyp-gdg\.com now owns "Budget"/);
  assert.match(calls.find(c => c.startsWith('permissions.create'))!, /"transferOwnership":true,"requestBody":\{"type":"user","role":"owner","emailAddress":"azlan@nyp-gdg.com"\}/);

  ({ tools, calls } = workspace({ [mine.id]: mine }));
  assert.match(await tools.drive_share.invoke({ action: 'transfer_ownership', url: mine.id, email: 'friend@gmail.com' }) as string, /need to accept it/);
  assert.match(calls.find(c => c.startsWith('permissions.update'))!, /"pendingOwner":true/);
  assert.equal(calls.some(c => c.includes('transferOwnership')), false);

  ({ tools } = workspace({ [inSharedDrive.id]: inSharedDrive, [theirs.id]: theirs }));
  await assert.rejects(tools.drive_share.invoke({ action: 'transfer_ownership', url: inSharedDrive.id, email: 'azlan@nyp-gdg.com' }), /in a shared drive, so it belongs to the drive/);
  await assert.rejects(tools.drive_share.invoke({ action: 'transfer_ownership', url: theirs.id, email: 'mary@nyp-gdg.com' }), /Only the owner can transfer ownership.*owned by Azlan/);
});

test('sharing: add, link on and off', async () => {
  let { tools, calls } = workspace({ [mine.id]: mine });
  assert.equal(await tools.drive_share.invoke({ action: 'add', url: mine.id, email: 'mary@nyp-gdg.com', role: 'commenter' }), 'Shared "Budget" with mary@nyp-gdg.com as commenter.');
  assert.match(last(calls)!, /"role":"commenter","emailAddress":"mary@nyp-gdg.com"/);
  ({ tools, calls } = workspace({ [mine.id]: mine }, { permissions: [{ id: 'anyone1', type: 'anyone', role: 'reader' }] }));
  assert.match(await tools.drive_share.invoke({ action: 'link', url: mine.id, role: 'off' }) as string, /Turned link sharing off/);
  assert.match(last(calls)!, /^permissions\.delete .*"permissionId":"anyone1"/);
});

test('trash never deletes, convert copies to a native file next to the original, Office files must be converted first', async () => {
  const docx = { id: LONG('docx'), name: 'Proposal.docx', mimeType: MIME.docx, parents: ['folder1'] };
  const { tools, calls } = workspace({ [mine.id]: mine, [docx.id]: docx });
  assert.match(await tools.drive_manage.invoke({ action: 'trash', url: mine.id }) as string, /restored from the trash for 30 days/);
  assert.match(last(calls)!, /^files\.update .*"requestBody":\{"trashed":true\}/);
  assert.equal(calls.some(c => c.startsWith('files.delete')), false);

  assert.match(await tools.drive_manage.invoke({ action: 'convert', url: docx.id }) as string, /The original Word \(\.docx\) file is unchanged/);
  assert.match(last(calls)!, /^files\.copy .*"name":"Proposal","mimeType":"application\/vnd\.google-apps\.document","parents":\["folder1"\]/);

  await assert.rejects(tools.docs_edit.invoke({ url: docx.id, action: 'replace_text', find: 'a', replace: 'b' }), /can't be edited directly\. Convert it with drive_manage/);
});

test('a private image is shared by link only while it is inserted, and unshared even if inserting fails', async () => {
  const doc = { id: LONG('doc'), name: 'Proposal', mimeType: MIME.doc };
  const logo = { id: LONG('logo'), name: 'logo.png', mimeType: 'image/png' };
  const { tools, calls } = workspace({ [doc.id]: doc, [logo.id]: logo }, { docsBatchUpdate: async () => { throw Object.assign(new Error('bad image'), { code: 400 }); } });
  await assert.rejects(tools.docs_edit.invoke({ url: doc.id, action: 'insert_image', image: logo.id }), /bad image/);
  const sharing = calls.filter(c => c.startsWith('permissions.'));
  assert.match(sharing[1], /^permissions\.create .*"type":"anyone","role":"reader"/);
  assert.match(sharing[2], /^permissions\.delete .*"permissionId":"perm1"/);

  // An image sent on WhatsApp is uploaded, shared, and the upload deleted afterwards
  const ok = workspace({ [doc.id]: doc });
  await ok.tools.docs_edit.invoke({ url: doc.id, action: 'insert_image', image: 'WAMEDIA1' });
  assert.match(ok.calls.find(c => c.startsWith('docs.batchUpdate'))!, /"uri":"https:\/\/lh3\.googleusercontent\.com\/d\/upload1"/);
  assert.match(last(ok.calls)!, /^files\.delete .*"fileId":"upload1"/);
});

test("a public image Google can't fetch is downloaded and inserted from a temporary Drive copy, which is deleted", async () => {
  const doc = { id: LONG('doc'), name: 'Proposal', mimeType: MIME.doc };
  let attempts = 0;
  const uris: string[] = [];
  const { tools, calls } = workspace({ [doc.id]: doc }, {
    docsBatchUpdate: async ({ requestBody }: any) => {
      const uri = requestBody.requests[0].insertInlineImage.uri;
      uris.push(uri);
      if (attempts++ == 0) throw Object.assign(new Error('There was a problem retrieving the image. The provided image should be publicly accessible'), { code: 400 });
      return { data: { replies: [] } };
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': 'image/png' } })) as any;
  try {
    assert.match(await tools.docs_edit.invoke({ url: doc.id, action: 'insert_image', image: 'http://93.184.216.34/logo.png' }) as string, /Inserted the image/);
  }
  finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(uris, ['http://93.184.216.34/logo.png', 'https://lh3.googleusercontent.com/d/upload1']);
  assert.match(calls.find(c => c.startsWith('files.create'))!, /"name":"\[Sofia temporary image\] 93\.184\.216\.34"/);
  assert.match(last(calls), /^files\.delete .*"fileId":"upload1"/);
});

test('a slide with a layout from another master is created next to a slide using that master, then moved where it belongs', async () => {
  const deck = { id: LONG('deck'), name: 'Brand Guide', mimeType: MIME.slides, webViewLink: 'https://docs.google.com/presentation/d/deck/edit' };
  const presentation = {
    layouts: [
      { objectId: 'plain', layoutProperties: { displayName: 'Plain', masterObjectId: 'simple' } },
      { objectId: 'branded', layoutProperties: { displayName: 'Header 02 (white)', masterObjectId: 'devfest' } },
    ],
    slides: [
      { objectId: 's1', slideProperties: { layoutObjectId: 'branded' } },
      { objectId: 's2', slideProperties: { layoutObjectId: 'branded' } },
      { objectId: 's3', slideProperties: { layoutObjectId: 'plain' } },
      { objectId: 's4', slideProperties: { layoutObjectId: 'plain' } },
    ],
  };
  const batches: any[][] = [];
  const { tools } = workspace({ [deck.id]: deck }, {
    slides: { presentations: { get: async () => ({ data: presentation }), batchUpdate: async ({ requestBody }: any) => { batches.push(requestBody.requests); return { data: { replies: [] } }; } } },
  });
  // Appending to the end (after a "plain" slide) isn't allowed, so it's created after s2 and moved to the end
  await tools.slides_edit.invoke({ url: deck.id, action: 'add_slide', layout: 'header 02 (white)' });
  assert.equal(batches[0][0].createSlide.insertionIndex, 2);
  assert.deepEqual(batches[0][0].createSlide.slideLayoutReference, { layoutId: 'branded' });
  assert.equal(batches[0][1].updateSlidesPosition.insertionIndex, 5);
  // Next to a slide with the same master already: created right there, not moved
  await tools.slides_edit.invoke({ url: deck.id, action: 'add_slide', layout: 'Header 02 (white)', position: 2 });
  assert.equal(batches[1][0].createSlide.insertionIndex, 1);
  assert.equal(batches[1].length, 1);
  // Several slides deleted in one request
  await tools.slides_edit.invoke({ url: deck.id, action: 'delete_slide', slides: ['3', 's4'] });
  assert.deepEqual(batches[2], [{ deleteObject: { objectId: 's3' } }, { deleteObject: { objectId: 's4' } }]);
});

test('smart chip text becomes Docs requests in order, each chip taking one index', async () => {
  const { parseChipText, chipTextToDocsRequests, chipTextToSheetCell, dateChipProperties } = await import('../src/services/workspaceEdit');
  const segments = parseChipText('OIC: [[person:azlan@nyp-gdg.com]] on [[date:2026-11-21T10:00]] (see [[file:https://docs.google.com/document/d/abc/edit]])');
  assert.deepEqual(segments.map(s => s.type), ['text', 'person', 'text', 'date', 'text', 'file', 'text']);
  assert.deepEqual(chipTextToDocsRequests(segments, 100, 't.1'), [
    { insertText: { location: { index: 100, tabId: 't.1' }, text: 'OIC: ' } },
    { insertPerson: { location: { index: 105, tabId: 't.1' }, personProperties: { email: 'azlan@nyp-gdg.com' } } },
    { insertText: { location: { index: 106, tabId: 't.1' }, text: ' on ' } },
    { insertDate: { location: { index: 110, tabId: 't.1' }, dateElementProperties: dateChipProperties('2026-11-21T10:00', true) } },
    { insertText: { location: { index: 111, tabId: 't.1' }, text: ' (see ' } },
    { insertRichLink: { location: { index: 117, tabId: 't.1' }, richLinkProperties: { uri: 'https://docs.google.com/document/d/abc/edit' } } },
    { insertText: { location: { index: 118, tabId: 't.1' }, text: ')' } },
  ]);
  // A time shows in Singapore time with the zone; a date alone is midday UTC, the same day everywhere
  assert.deepEqual(dateChipProperties('2026-11-21T10:00', true), { timestamp: '2026-11-21T02:00:00.000Z', timeZoneId: 'Asia/Singapore', dateFormat: 'DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED', timeFormat: 'TIME_FORMAT_HOUR_MINUTE_TIMEZONE' });
  assert.deepEqual(dateChipProperties('2026-11-21', false), { timestamp: '2026-11-21T12:00:00Z', dateFormat: 'DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED', timeFormat: 'TIME_FORMAT_DISABLED' });
  assert.throws(() => parseChipText('[[person:Azlan]]'), /isn't an email/);
  assert.throws(() => parseChipText('[[date:next friday]]'), /isn't a date/);

  // Sheets: each chip is an @ with a chip run at its position; no date chips
  assert.deepEqual(chipTextToSheetCell(parseChipText('See [[file:https://docs.google.com/document/d/abc/edit]] or ask [[person:mary@nyp-gdg.com]]')), {
    userEnteredValue: { stringValue: 'See @ or ask @' },
    chipRuns: [{ startIndex: 4, chip: { richLinkProperties: { uri: 'https://docs.google.com/document/d/abc/edit' } } }, { startIndex: 13, chip: { personProperties: { email: 'mary@nyp-gdg.com' } } }],
  });
  assert.throws(() => chipTextToSheetCell(parseChipText('[[date:2026-11-21]]')), /Sheets has no date chips/);
});

test('text is found in paragraphs and table cells with document indices, chips counting as one character', async () => {
  const { findDocText } = await import('../src/services/workspaceFormat');
  const body: any[] = [
    { startIndex: 1, endIndex: 20, paragraph: { elements: [{ startIndex: 1, textRun: { content: 'Organiser: ' } }, { startIndex: 12, person: { personProperties: { email: 'a@b.c' } } }, { startIndex: 13, textRun: { content: ' (OIC)\n' } }] } },
    { startIndex: 20, endIndex: 40, table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 22, paragraph: { elements: [{ startIndex: 22, textRun: { content: 'Venue\n' } }] } }] }, { content: [{ startIndex: 29, paragraph: { elements: [{ startIndex: 29, textRun: { content: 'TBC\n' } }] } }] }] }] } },
  ];
  assert.deepEqual(findDocText(body, 'Organiser:'), { start: 1, end: 11 });
  assert.deepEqual(findDocText(body, '(oic)'), { start: 14, end: 19 }); // after the chip, case-insensitive
  assert.deepEqual(findDocText(body, 'TBC'), { start: 29, end: 32 });
  assert.equal(findDocText(body, 'nowhere'), null);
});

test('writing to a multi-tab sheet needs the tab, and a chip after a label gets a space', async () => {
  const sheet = { id: LONG('sheet'), name: 'RAMs', mimeType: MIME.sheet };
  const doc = { id: LONG('doc'), name: 'Proposal', mimeType: MIME.doc };
  const batches: any[] = [];
  const { tools } = workspace({ [sheet.id]: sheet, [doc.id]: doc }, {
    sheets: { spreadsheets: { get: async () => ({ data: { sheets: [{ properties: { sheetId: 0, title: 'RPN' } }, { properties: { sheetId: 5, title: 'RA Form B' } }] } }) } },
    docsBatchUpdate: async ({ requestBody }: any) => { batches.push(requestBody.requests); return { data: { replies: [] } }; },
  });
  await assert.rejects(tools.sheets_edit.invoke({ url: sheet.id, action: 'clear', range: 'A4:A6' }), /has 2 tabs: "RPN", "RA Form B"\. Say which one with tab/);
  await tools.docs_edit.invoke({ url: doc.id, action: 'insert_inline', after_text: 'Hello', text: '[[person:azlan@nyp-gdg.com]]' });
  // The fake doc's "Hello" starts at index 0, so the text ends at 5
  assert.deepEqual(batches[0].slice(0, 2), [
    { insertText: { location: { index: 5, tabId: 't.0' }, text: ' ' } },
    { insertPerson: { location: { index: 6, tabId: 't.0' }, personProperties: { email: 'azlan@nyp-gdg.com' } } },
  ]);
});

test('a generated image (img_N) is inserted from a temporary Drive copy, which is deleted', async () => {
  const doc = { id: LONG('doc'), name: 'Proposal', mimeType: MIME.doc };
  const { tools, calls } = workspace({ [doc.id]: doc });
  await tools.docs_edit.invoke({ url: doc.id, action: 'insert_image', image: 'img_1' });
  assert.match(calls.find(c => c.startsWith('files.create'))!, /\[Sofia temporary image\] img_1/);
  assert.match(calls.find(c => c.startsWith('docs.batchUpdate'))!, /lh3\.googleusercontent\.com\/d\/upload1/);
  assert.match(last(calls), /^files\.delete .*"fileId":"upload1"/);
  await assert.rejects(tools.docs_edit.invoke({ url: doc.id, action: 'insert_image', image: 'img_9' }), /img_9 isn't available any more/);
});
