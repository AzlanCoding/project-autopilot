import { test } from 'node:test';
const last = <T>(list: T[]): T => list[list.length - 1];
import assert from 'node:assert/strict';
import {
  a1ToGridRange, docTableCellRequests, hexColor, imageFormula, markdownToDocsRequests, parseInlineMarkdown, parseMarkdownBlocks,
  parseRequests, sheetFormatRequest, slideSetTextRequests,
} from '../src/services/workspaceEdit';
import { GoogleWorkspace, MIME } from '../src/services/googleWorkspace';
import { createWorkspaceWriteTools } from '../src/services/workspaceWriteTools';
import { planSlideCopy, slideMoveIndex } from '../src/services/slideCopy';

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
        get: overrides.docsGet ?? (async () => ({ data: { tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 7, paragraph: { elements: [{ textRun: { content: 'Hello\n' } }] } }] } } }] } })),
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

test('batch requests with unquoted property names or trailing commas are repaired, other broken JSON explains the rules', async () => {
  const { parseRequests } = await import('../src/services/workspaceEdit');
  assert.deepEqual(parseRequests('[{createShape: {objectId: "card01", shapeType: "ROUND_RECTANGLE",},},]'), [{ createShape: { objectId: 'card01', shapeType: 'ROUND_RECTANGLE' } }]);
  // Text inside strings is never changed, even when the rest needed repairing
  assert.deepEqual(parseRequests('[{insertText: {objectId: "lbl01", text: "01, LOAD: pull, then {x: 1},"},}]'), [{ insertText: { objectId: 'lbl01', text: '01, LOAD: pull, then {x: 1},' } }]);
  assert.deepEqual(parseRequests('[{"insertText": {"objectId": "lbl01", "text": "01, LOAD: pull the text out"}}]'), [{ insertText: { objectId: 'lbl01', text: '01, LOAD: pull the text out' } }]);
  assert.throws(() => parseRequests("[{'insertText': {}}]"), /Use double quotes around every property name and string/);
});

test('Doc tabs are added (inside another tab, with content), renamed and deleted, never the first tab by default', async () => {
  const doc = { id: LONG('doc'), name: 'Proposal', mimeType: MIME.doc, webViewLink: 'https://docs.google.com/document/d/doc/edit?usp=drivesdk' };
  const empty = { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 2, paragraph: { elements: [{ textRun: { content: '\n' } }] } }] };
  const tabs = [
    { tabProperties: { tabId: 't.0', title: 'Proposal' }, documentTab: { body: empty } },
    { tabProperties: { tabId: 't.1', title: 'Minutes' }, documentTab: { body: empty }, childTabs: [{ tabProperties: { tabId: 't.2', title: 'Week 1' }, documentTab: { body: empty } }] },
    { tabProperties: { tabId: 't.3', title: 'Budget' }, documentTab: { body: empty } },
  ];
  const batches: any[][] = [];
  const { tools } = workspace({ [doc.id]: doc }, {
    docsGet: async () => ({ data: { tabs } }),
    docsBatchUpdate: async ({ requestBody }: any) => { batches.push(requestBody.requests); return { data: { replies: [{ addDocumentTab: { tabProperties: { tabId: 't.new' } } }] } }; },
  });
  assert.match(await tools.docs_edit.invoke({ url: doc.id, action: 'add_tab', new_name: 'Week 2', parent_tab: 'minutes', position: 2, markdown: '# Week 2' }) as string, /Added tab "Week 2" \(id t\.new\) inside "Minutes".*\?tab=t\.new/);
  assert.deepEqual(batches[0], [{ addDocumentTab: { tabProperties: { title: 'Week 2', parentTabId: 't.1', index: 1 } } }]);
  // The content goes in the new tab, at its start
  assert.deepEqual(batches[1][0], { insertText: { location: { index: 1, tabId: 't.new' }, text: 'Week 2\n' } });

  // Sofia named the new tab with tab, as sheets_edit add_tab does, and was told "There's no tab" (2026-10-25)
  await tools.docs_edit.invoke({ url: doc.id, action: 'add_tab', tab: 'Post-event notes' });
  assert.deepEqual(last(batches), [{ addDocumentTab: { tabProperties: { title: 'Post-event notes' } } }]);

  await tools.docs_edit.invoke({ url: doc.id, action: 'rename_tab', tab: 'Budget', new_name: 'Costs' });
  assert.deepEqual(last(batches), [{ updateDocumentTabProperties: { tabProperties: { tabId: 't.3', title: 'Costs' }, fields: 'title' } }]);

  await assert.rejects(tools.docs_edit.invoke({ url: doc.id, action: 'delete_tab' }), /Say which tab to delete with tab\. Tabs: "Proposal" \(id t\.0\), "Minutes" \(id t\.1\), "Week 1" \(id t\.2, inside "Minutes"\)/);
  assert.match(await tools.docs_edit.invoke({ url: doc.id, action: 'delete_tab', tab: 'Minutes' }) as string, /Deleted tab "Minutes" and the tabs inside it \("Week 1"\)/);
  assert.deepEqual(last(batches), [{ deleteTab: { tabId: 't.1' } }]);

  // Markdown in an empty tab replaces its empty paragraph instead of going after it
  await tools.docs_edit.invoke({ url: `https://docs.google.com/document/d/${doc.id}/edit?tab=t.3`, action: 'insert_markdown', markdown: 'Total: $120' });
  assert.deepEqual(last(batches)[0], { insertText: { location: { index: 1, tabId: 't.3' }, text: 'Total: $120\n' } });
});

test('a Sheet tab is duplicated next to itself, or copied into another Sheet keeping its name when that is free', async () => {
  const a = { id: LONG('sheetA'), name: 'Budget', mimeType: MIME.sheet, webViewLink: 'https://docs.google.com/spreadsheets/d/a/edit?usp=drivesdk' };
  const b = { id: LONG('sheetB'), name: 'Budget 2027', mimeType: MIME.sheet, webViewLink: 'https://docs.google.com/spreadsheets/d/b/edit?usp=drivesdk' };
  const tabsOf: any = {
    [a.id]: [{ properties: { sheetId: 0, title: 'Data', index: 0 } }, { properties: { sheetId: 7, title: 'Summary', index: 1 } }],
    [b.id]: [{ properties: { sheetId: 0, title: 'Summary', index: 0 } }, { properties: { sheetId: 99, title: 'Copy of Data', index: 1 } }],
  };
  const batches: any[] = [];
  const copies: any[] = [];
  const { tools } = workspace({ [a.id]: a, [b.id]: b }, {
    sheets: {
      spreadsheets: {
        get: async ({ spreadsheetId }: any) => ({ data: { sheets: tabsOf[spreadsheetId] } }),
        batchUpdate: async (params: any) => { batches.push(params); return { data: { replies: [{ duplicateSheet: { properties: { sheetId: 42, title: 'Copy of Data' } } }] } }; },
        sheets: { copyTo: async (params: any) => { copies.push(params); return { data: { sheetId: 99, title: params.sheetId == 7 ? 'Copy of Summary' : 'Copy of Data' } }; } },
        values: { get: async () => ({ data: { values: [['Total', '=SUM(Data!B2:B10)']] } }) },
      },
    },
  });
  assert.match(await tools.sheets_edit.invoke({ url: a.id, action: 'duplicate_tab', tab: 'Data' }) as string, /Duplicated tab "Data" as "Copy of Data" \(id 42\)\. https:\/\/docs\.google\.com\/spreadsheets\/d\/a\/edit#gid=42/);
  assert.deepEqual(batches[0].requestBody.requests, [{ duplicateSheet: { sourceSheetId: 0, insertSheetIndex: 1 } }]);

  // "Data" is free in the other Sheet, so the copy is renamed back from "Copy of Data" and moved first
  assert.match(await tools.sheets_edit.invoke({ url: a.id, action: 'duplicate_tab', tab: 'Data', to_url: b.id, position: 1 }) as string, /Copied tab "Data" into "Budget 2027" as "Data"/);
  assert.deepEqual(copies[0], { spreadsheetId: a.id, sheetId: 0, requestBody: { destinationSpreadsheetId: b.id } });
  assert.deepEqual(last(batches), { spreadsheetId: b.id, requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: 99, title: 'Data', index: 0 }, fields: 'title,index' } }] } });

  // "Summary" is taken there: it stays "Copy of Summary", and formulas pointing at other tabs are flagged
  batches.length = 0;
  const result = await tools.sheets_edit.invoke({ url: a.id, action: 'duplicate_tab', tab: 'Summary', to_url: b.id }) as string;
  assert.match(result, /as "Copy of Summary".*formulas refer to other tabs.*#REF!/);
  assert.equal(batches.length, 0);
});

test('slides moved or duplicated to a position end up exactly there, though the API counts positions before the move', async () => {
  // A B C: moving A to 3 needs index 3 (after C), not 2, which left it second
  assert.equal(slideMoveIndex(['A', 'B', 'C'], ['A'], 3), 3);
  assert.equal(slideMoveIndex(['A', 'B', 'C'], ['C'], 1), 0);
  assert.equal(slideMoveIndex(['A', 'B', 'C'], ['B'], 2), 2);
  // Copies of A and B right after their originals (A A' B B'), moved together to position 3: after B
  assert.equal(slideMoveIndex(['A', "A'", 'B', "B'"], ["A'", "B'"], 3), 4);
});

/** A deck with a master and layout whose placeholders give the text its look (font, size, colour per list level). */
function brandedDeck() {
  const run = (content: string, style: any) => ({ textRun: { content, style } });
  return {
    pageSize: { width: { magnitude: 9144000, unit: 'EMU' }, height: { magnitude: 5143500, unit: 'EMU' } },
    masters: [{
      objectId: 'master1', masterProperties: { displayName: 'DevFest 2023' },
      pageProperties: { pageBackgroundFill: { solidFill: { color: { themeColor: 'LIGHT2' } } }, colorScheme: { colors: [{ type: 'LIGHT2', color: { red: 0.9, green: 0.9, blue: 0.9 } }, { type: 'ACCENT1', color: { red: 0.26, green: 0.52, blue: 0.96 } }] } },
      pageElements: [
        { objectId: 'm_logo', size: { width: { magnitude: 100 }, height: { magnitude: 50 } }, transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 20, unit: 'EMU' }, image: { contentUrl: 'https://lh3.googleusercontent.com/logo' } },
        { objectId: 'm_body', shape: { shapeType: 'TEXT_BOX', placeholder: { type: 'BODY' }, text: { textElements: [
          { startIndex: 0, endIndex: 1, paragraphMarker: { style: { alignment: 'START', spaceBelow: { magnitude: 12, unit: 'PT' } } } }, { startIndex: 0, endIndex: 1, ...run('\n', { fontFamily: 'Roboto Mono', fontSize: { magnitude: 18, unit: 'PT' }, foregroundColor: { opaqueColor: { themeColor: 'ACCENT1' } } }) },
          { startIndex: 1, endIndex: 2, paragraphMarker: { style: { alignment: 'START' } } }, { startIndex: 1, endIndex: 2, ...run('\n', { fontFamily: 'Roboto Mono', fontSize: { magnitude: 14, unit: 'PT' } }) },
        ] }, shapeProperties: { shapeBackgroundFill: { propertyState: 'NOT_RENDERED' }, outline: { propertyState: 'NOT_RENDERED' }, contentAlignment: 'TOP' } } },
      ],
    }],
    layouts: [{
      objectId: 'layout1', layoutProperties: { displayName: 'Title and body', masterObjectId: 'master1' },
      pageElements: [{ objectId: 'l_body', size: { width: { magnitude: 3000000 }, height: { magnitude: 3000000 } }, transform: { scaleX: 2, scaleY: 1, translateX: 300000, translateY: 1000000, unit: 'EMU' }, shape: { shapeType: 'TEXT_BOX', placeholder: { type: 'BODY', parentObjectId: 'm_body' }, shapeProperties: { shapeBackgroundFill: { propertyState: 'INHERIT' }, outline: { propertyState: 'INHERIT' } } } }],
    }],
    slides: [{
      objectId: 'slide1', slideProperties: {
        layoutObjectId: 'layout1', masterObjectId: 'master1',
        notesPage: { notesProperties: { speakerNotesObjectId: 'notes1' }, pageElements: [{ objectId: 'notes1', shape: { text: { textElements: [run('Say hello\n', {})] } } }] },
      },
      pageElements: [
        // Body text: "Point" bold, then a nested list item, with everything else inherited
        { objectId: 'body1', size: { width: { magnitude: 3000000 }, height: { magnitude: 3000000 } }, transform: { scaleX: 2, scaleY: 1, translateX: 300000, translateY: 1000000, unit: 'EMU' }, shape: {
          shapeType: 'TEXT_BOX', placeholder: { type: 'BODY', parentObjectId: 'l_body' },
          shapeProperties: { shapeBackgroundFill: { propertyState: 'INHERIT' }, outline: { propertyState: 'INHERIT' }, autofit: { fontScale: 1 } },
          text: { textElements: [
            { startIndex: 0, endIndex: 10, paragraphMarker: { style: {}, bullet: { listId: 'l', glyph: '●' } } }, { startIndex: 0, endIndex: 5, ...run('Point', { bold: true }) }, { startIndex: 5, endIndex: 10, ...run(' one\n', {}) },
            { startIndex: 10, endIndex: 14, paragraphMarker: { style: {}, bullet: { listId: 'l', nestingLevel: 1, glyph: '○' } } }, { startIndex: 10, endIndex: 14, ...run('Sub\n', {}) },
          ] },
        } },
        // A group of two shapes, moved 100 to the right as a whole
        { objectId: 'group1', transform: { scaleX: 1, scaleY: 1, translateX: 100, translateY: 0, unit: 'EMU' }, elementGroup: { children: [
          { objectId: 'dot1', size: { width: { magnitude: 50 }, height: { magnitude: 50 } }, transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 10, unit: 'EMU' }, shape: { shapeType: 'ELLIPSE', shapeProperties: { shapeBackgroundFill: { solidFill: { color: { themeColor: 'ACCENT1' } } }, outline: { propertyState: 'NOT_RENDERED' } } } },
          { objectId: 'dot2', size: { width: { magnitude: 50 }, height: { magnitude: 50 } }, transform: { scaleX: 1, scaleY: 1, translateX: 70, translateY: 10, unit: 'EMU' }, shape: { shapeType: 'ELLIPSE' } },
        ] } },
        { objectId: 'chart1', size: { width: { magnitude: 400 }, height: { magnitude: 300 } }, sheetsChart: { spreadsheetId: 'x', chartId: 1, contentUrl: 'https://lh3.googleusercontent.com/chart' } },
        { objectId: 'art1', wordArt: { renderedText: 'Wow' } },
      ],
    }],
  };
}

/** A plain deck with a Blank layout (only a slide number) and its own Title and body layout. */
function plainDeck(masterName = 'Simple Light') {
  return {
    pageSize: { width: { magnitude: 9144000, unit: 'EMU' }, height: { magnitude: 5143500, unit: 'EMU' } },
    masters: [{ objectId: 'pm', masterProperties: { displayName: masterName } }],
    layouts: [
      { objectId: 'p_blank', layoutProperties: { name: 'BLANK', displayName: 'Blank', masterObjectId: 'pm' }, pageElements: [{ objectId: 'p_num', shape: { placeholder: { type: 'SLIDE_NUMBER' } } }] },
      { objectId: 'p_tb', layoutProperties: { name: 'TITLE_AND_BODY', displayName: 'Title and body', masterObjectId: 'pm' }, pageElements: [
        { objectId: 'p_title', size: { width: { magnitude: 3000000 }, height: { magnitude: 3000000 } }, shape: { placeholder: { type: 'TITLE' } } },
        { objectId: 'p_body', size: { width: { magnitude: 3000000 }, height: { magnitude: 3000000 } }, shape: { placeholder: { type: 'BODY' } } },
      ] },
    ],
    slides: [{ objectId: 'existing', slideProperties: { layoutObjectId: 'p_blank' } }],
  };
}

test("a slide copied to a deck with another template keeps its look: inherited styles, theme colours, background and the template's logo", () => {
  const source: any = brandedDeck();
  let n = 0;
  const plan = planSlideCopy(source, source.slides[0], plainDeck() as any, 1, 'source', p => `${p}_${++n}`);
  const r = plan.requests;
  assert.equal(plan.layout, 'Blank');
  assert.equal(plan.placeholders, false);
  assert.deepEqual(r[0], { createSlide: { objectId: plan.slideId, insertionIndex: 1, slideLayoutReference: { layoutId: 'p_blank' } } });
  // The master's background, its theme colour turned into the colour it has in the source deck
  assert.deepEqual(r[1], { updatePageProperties: { objectId: plan.slideId, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: { red: 0.9, green: 0.9, blue: 0.9 } } } } }, fields: 'pageBackgroundFill' } });
  // The master's logo first (behind), its placeholder isn't copied
  assert.equal(r[2].createImage?.url, 'https://lh3.googleusercontent.com/logo');
  assert.equal(r.filter(q => q.createShape).length, 3);

  const body = r.find(q => q.createShape?.shapeType == 'TEXT_BOX')!.createShape!.objectId!;
  const on = (kind: string) => r.filter((q: any) => q[kind]?.objectId == body).map((q: any) => q[kind]);
  // Nested list items go in with a tab per level, which createParagraphBullets turns into the nesting
  assert.deepEqual(on('insertText'), [{ objectId: body, insertionIndex: 0, text: 'Point one\n\tSub' }]);
  assert.deepEqual(on('createParagraphBullets'), [{ objectId: body, textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: 14 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' }]);
  // Each list level's look comes from the master's paragraph for that level
  const styles = on('updateTextStyle');
  assert.deepEqual(styles[0].style, { bold: true, fontSize: { magnitude: 18, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: { red: 0.26, green: 0.52, blue: 0.96 } } }, fontFamily: 'Roboto Mono' });
  assert.equal(styles[0].fields, 'bold,fontSize,foregroundColor,fontFamily');
  assert.deepEqual(styles[2].style, { fontSize: { magnitude: 14, unit: 'PT' }, fontFamily: 'Roboto Mono' });
  assert.deepEqual(on('updateParagraphStyle')[0].style, { alignment: 'START', spaceBelow: { magnitude: 12, unit: 'PT' } });
  assert.deepEqual(on('updateShapeProperties')[0].shapeProperties, { shapeBackgroundFill: { propertyState: 'NOT_RENDERED' }, outline: { propertyState: 'NOT_RENDERED' }, contentAlignment: 'TOP' });

  // Group children are placed where the group put them, then grouped again
  const dots = r.filter(q => q.createShape?.shapeType == 'ELLIPSE').map(q => q.createShape!);
  assert.deepEqual(dots.map(d => d.elementProperties!.transform!.translateX), [110, 170]);
  assert.deepEqual(r.find(q => q.groupObjects)!.groupObjects!.childrenObjectIds, dots.map(d => d.objectId));
  // Charts become images, word art can't be made
  assert.equal(r.filter(q => q.createImage).length, 2);
  assert.deepEqual(plan.skipped, ['word art']);
  assert.equal(plan.notes, 'Say hello');
});

test("a slide copied to a deck with the same template, or with the other deck's design, fills that deck's placeholders", () => {
  const source: any = brandedDeck();
  for (const [target, design] of [[plainDeck('DevFest 2023'), 'source'], [plainDeck(), 'destination']] as const) {
    let n = 0;
    const plan = planSlideCopy(source, source.slides[0], target as any, 1, design, p => `${p}_${++n}`);
    assert.equal(plan.layout, 'Title and body');
    assert.equal(plan.placeholders, true);
    // Only the body placeholder is used, so only it is mapped (the title is removed later as an empty placeholder)
    const ph = plan.requests[0].createSlide!.placeholderIdMappings!;
    assert.deepEqual(ph.map(m => m.layoutPlaceholderObjectId), ['p_body']);
    assert.equal(plan.requests.some(q => q.updatePageProperties), false);
    assert.equal(plan.requests.some(q => q.createImage?.url?.endsWith('logo')), false);
    // It stays where it was, and keeps the slide's own bold, its theme colours and font size, not the old font
    assert.deepEqual(plan.requests.find(q => q.updatePageElementTransform)!.updatePageElementTransform, { objectId: ph[0].objectId, applyMode: 'ABSOLUTE', transform: { scaleX: 2, scaleY: 1, translateX: 300000, translateY: 1000000, unit: 'EMU', shearX: 0, shearY: 0 } });
    const style = plan.requests.find(q => q.updateTextStyle?.objectId == ph[0].objectId)!.updateTextStyle!;
    assert.deepEqual(style.style, { bold: true, fontSize: { magnitude: 18, unit: 'PT' } });
  }
});

test('copying slides into another deck adds their speaker notes and removes empty placeholders left by the layout', async () => {
  const from = { id: LONG('from'), name: 'Old deck', mimeType: MIME.slides, webViewLink: 'https://docs.google.com/presentation/d/from/edit' };
  const to = { id: LONG('to'), name: 'New deck', mimeType: MIME.slides, webViewLink: 'https://docs.google.com/presentation/d/to/edit' };
  const target: any = plainDeck('DevFest 2023');
  const batches: any[] = [];
  const { tools } = workspace({ [from.id]: from, [to.id]: to }, {
    slides: { presentations: {
      get: async ({ presentationId }: any) => ({ data: presentationId == from.id ? brandedDeck() : target }),
      batchUpdate: async ({ presentationId, requestBody }: any) => {
        batches.push({ presentationId, requests: requestBody.requests });
        const created = requestBody.requests[0].createSlide;
        if (created) {
          // The new slide, with the layout's title placeholder still empty
          target.slides = [...target.slides, { objectId: created.objectId, slideProperties: { layoutObjectId: 'p_tb', notesPage: { notesProperties: { speakerNotesObjectId: 'new_notes' } } }, pageElements: [
            { objectId: 'empty_title', shape: { placeholder: { type: 'TITLE' } } },
            { objectId: created.placeholderIdMappings[0].objectId, shape: { placeholder: { type: 'BODY' }, text: { textElements: [{ textRun: { content: 'Point one\n' } }] } } },
          ] }];
        }
        return { data: { replies: [] } };
      },
    } },
  });
  const result = await tools.slides_edit.invoke({ url: from.id, action: 'duplicate_slide', slide: '1', to_url: to.id }) as string;
  assert.match(result, /Copied the slide into "New deck": slide 1 -> slide 2 \(slide_\w+, its "Title and body" layout\)\. Couldn't copy word art\./);
  assert.equal(batches.every(b => b.presentationId == to.id), true);
  assert.deepEqual(batches[1].requests, [{ deleteObject: { objectId: 'empty_title' } }, { insertText: { objectId: 'new_notes', insertionIndex: 0, text: 'Say hello' } }]);
});
