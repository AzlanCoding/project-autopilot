import { test } from 'node:test';
import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import { defaultSemester, describeDateWeek, semesterWeekOf, SEMESTERS, WK_Number_to_timeframe } from '../src/utils/common';

const at = (date: string) => { const w = semesterWeekOf(date); return w ? `${w.semester.name} W${w.week}` : null; };

test('dates map to the semester and Monday-to-Sunday week they fall in', () => {
  const weeks: [string, string | null][] = [
    ['2026-04-19', null], ['2026-04-20', 'Semester 1 W1'], ['2026-06-14', 'Semester 1 W8'], ['2026-06-15', 'Semester 1 W9'],
    ['2026-06-29', 'Semester 1 W11'], ['2026-08-17', 'Semester 1 W18'], ['2026-09-07', 'Semester 1 W21'],
    // This week is the last week of Semester 1's vacation, not a Week 0
    ['2026-10-17', 'Semester 1 W26'], ['2026-10-18', 'Semester 1 W26'],
    ['2026-10-19', 'Semester 2 W1'], ['2026-12-20', 'Semester 2 W9'], ['2026-12-21', 'Semester 2 W10'], ['2027-01-04', 'Semester 2 W12'],
    ['2027-02-15', 'Semester 2 W18'], ['2027-03-08', 'Semester 2 W21'], ['2027-04-18', 'Semester 2 W26'], ['2027-04-19', null],
  ];
  assert.deepEqual(weeks.map(([date]) => [date, at(date)]), weeks);
});

test('each week says its semester and which part of the academic calendar it is in', () => {
  const [sem1, sem2] = SEMESTERS;
  const part = (week: number, sem = sem2) => WK_Number_to_timeframe(week, sem).match(/part of ([\w/ -]+) \(/)?.[1];
  assert.deepEqual([1, 8, 9, 10, 11, 17, 18, 20, 21, 26].map(w => part(w, sem1)),
    ['Instruction', 'Instruction', 'Mid-Sem Break', 'Mid-Sem Break', 'Instruction', 'Instruction', 'Study/Exam', 'Study/Exam', 'Vacation', 'Vacation']);
  assert.deepEqual([1, 9, 10, 11, 12, 17, 18, 20, 21, 26].map(w => part(w)),
    ['Instruction', 'Instruction', 'Mid-Sem Break', 'Mid-Sem Break', 'Instruction', 'Instruction', 'Study/Exam', 'Study/Exam', 'Vacation', 'Vacation']);
  assert.equal(WK_Number_to_timeframe(10, sem2), 'Semester 2, Week 10 is from 21/12/2026, Mon to 27/12/2026, Sun. It is part of Mid-Sem Break (Weeks 10-11, 21/12/2026, Mon to 03/01/2027, Sun).');
  assert.match(WK_Number_to_timeframe(27, sem2), /only has Weeks 1 to 26/);
  assert.match(describeDateWeek('2026-10-17'), /^2026-10-17 is in Semester 1, Week 26 is from 12\/10\/2026, Mon to 18\/10\/2026, Sun\. It is part of Vacation/);
  assert.match(describeDateWeek('2027-05-01'), /outside the academic calendar/);
});

test('week numbers default to the current semester, or the next one during its vacation', () => {
  const name = (date: string) => defaultSemester(moment(date)).name;
  assert.equal(name('2026-05-01'), 'Semester 1');
  assert.equal(name('2026-09-01'), 'Semester 1'); // Study/Exam
  assert.equal(name('2026-10-17'), 'Semester 2'); // Semester 1 vacation
  assert.equal(name('2026-11-01'), 'Semester 2');
  assert.equal(name('2026-01-01'), 'Semester 1'); // Before the calendar
});
