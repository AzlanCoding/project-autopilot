import { test } from 'node:test';
import assert from 'node:assert/strict';

// The module needs GOOGLE_CAL_ID when it loads, nothing here calls Google
process.env.GOOGLE_CAL_ID ||= 'test@group.calendar.google.com';
process.env.IGNORED_MODULES = 'IT9999';
const { formatTimetable } = require('../src/utils/getCalendarEvents') as typeof import('../src/utils/getCalendarEvents');

const event = (summary: string, from: string, to: string, location = 'L.520', module = summary.split(' ').find(w => /^IT\d+/.test(w)) ?? '') =>
  ({ summary, description: `${module} LAB01`, location, start: { dateTime: `2026-10-19T${from}:00+08:00` }, end: { dateTime: `2026-10-19T${to}:00+08:00` } });
const responsibleAI = event('(LAB07) IT2121 RESPONSIBLE AI', '09:00', '11:50');
const elearn = event('(ELEARN) IT2121 RESPONSIBLE AI', '09:00', '09:01', '');
const pem = event('IT-DIT PEM CONTACT TIME', '17:00', '17:50', 'L.504');

test('each calendar is its own section, titled with its name in the order given, with its classes in time order', () => {
  const deepLearning = event('(LAB02) IT2122 APPLIED DEEP LEARNING', '09:00', '11:50', 'L.532');
  const cloudOps = event('(LAB01) IT2127 CLOUD OPERATIONS', '09:00', '11:50', 'L.522');
  const responsibleAICloud = event('(LAB04) IT2121 RESPONSIBLE AI', '13:00', '15:50', 'L.425');
  const morningElearn = event('(ELEARN) IT2121 RESPONSIBLE AI', '08:00', '08:01', '');
  // Events out of time order
  const out = formatTimetable([
    { name: 'IT2504 Applied AI & Operations Timetable', events: [deepLearning, morningElearn] },
    { name: 'IT2504 DevOps & Automation in the Cloud Timetable', events: [responsibleAICloud, morningElearn, cloudOps] },
    { name: 'IT2504 Cybersecurity Timetable', events: [pem, responsibleAI, morningElearn, event('(LAB02) IT9999 IGNORED', '10:00', '11:00')] },
  ], true)!;
  const sections = out.split('\n\n').map(s => s.split('\n').filter(l => l.startsWith('*')));
  assert.deepEqual(sections, [
    ['*IT2504 Applied AI & Operations Timetable:*', '*(ELEARN) IT2121 RESPONSIBLE AI:*', '*(LAB02) IT2122 APPLIED DEEP LEARNING:*'],
    ['*IT2504 DevOps & Automation in the Cloud Timetable:*', '*(ELEARN) IT2121 RESPONSIBLE AI:*', '*(LAB01) IT2127 CLOUD OPERATIONS:*', '*(LAB04) IT2121 RESPONSIBLE AI:*'],
    // The module every track takes stays in each calendar's section, nothing is merged or moved out
    ['*IT2504 Cybersecurity Timetable:*', '*(ELEARN) IT2121 RESPONSIBLE AI:*', '*(LAB07) IT2121 RESPONSIBLE AI:*', '*IT-DIT PEM CONTACT TIME:*'],
  ]);
  assert.match(out, /\*\(LAB07\) IT2121 RESPONSIBLE AI:\*\n> 09:00 — 11:50\n> IT2121 LAB01\n> L\.520/);
});

test('a calendar with no classes says so, a single calendar has no sections, and no events at all gives nothing', () => {
  const out = formatTimetable([
    { name: 'IT2504 Applied AI & Operations Timetable', events: [] },
    { name: 'IT2504 Cybersecurity Timetable', events: [pem] },
  ], true)!;
  assert.equal(out, '*IT2504 Applied AI & Operations Timetable:*\n_No lessons for today_\n\n*IT2504 Cybersecurity Timetable:*\n*IT-DIT PEM CONTACT TIME:*\n> 17:00 — 17:50\n>  LAB01\n> L.504');
  // One calendar: classes in time order, no headings
  assert.equal(formatTimetable([{ name: 'IT2504', events: [pem, responsibleAI] }], true),
    '*(LAB07) IT2121 RESPONSIBLE AI:*\n> 09:00 — 11:50\n> IT2121 LAB01\n> L.520\n*IT-DIT PEM CONTACT TIME:*\n> 17:00 — 17:50\n>  LAB01\n> L.504');
  assert.equal(formatTimetable([{ name: 'A', events: [] }, { name: 'B', events: [] }], true), undefined);
});
