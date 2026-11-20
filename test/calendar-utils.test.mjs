import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarTaskRange, dateKey, getCalendarDays, shiftTaskSchedule
} from "../js/calendar-utils.mjs";

test("builds day and Monday-first week views", () => {
  const anchor = new Date(2026, 10, 19, 13);
  assert.deepEqual(getCalendarDays("day", anchor).map(dateKey), ["2026-11-19"]);
  assert.deepEqual(getCalendarDays("week", anchor).map(dateKey), [
    "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19",
    "2026-11-20", "2026-11-21", "2026-11-22"
  ]);
});

test("month view covers every date and full surrounding weeks", () => {
  const days = getCalendarDays("month", new Date(2026, 1, 15));
  assert.equal(dateKey(days[0]), "2026-01-26");
  assert.equal(dateKey(days.at(-1)), "2026-03-01");
  assert.equal(days.length % 7, 0);
  for (let day = 1; day <= 28; day++) {
    assert.ok(days.some(date => date.getMonth() === 1 && date.getDate() === day));
  }
});

test("dragging shifts start and due dates by the same number of days and preserves times", () => {
  const task = {
    startAt: new Date(2026, 10, 19, 9, 30),
    dueAt: new Date(2026, 10, 20, 17, 45)
  };
  const shifted = shiftTaskSchedule(task, "2026-11-19", new Date(2026, 10, 22));
  assert.equal(dateKey(shifted.startAt), "2026-11-22");
  assert.equal(dateKey(shifted.dueAt), "2026-11-23");
  assert.equal(shifted.startAt.getHours(), 9);
  assert.equal(shifted.startAt.getMinutes(), 30);
  assert.equal(shifted.dueAt.getHours(), 17);
  assert.equal(shifted.dueAt.getMinutes(), 45);
});

test("calendar ranges support due-only tasks and reverse invalid ranges safely", () => {
  const dueOnly = calendarTaskRange({ dueAt: "2026-11-20T08:00:00.000Z" });
  assert.equal(dateKey(dueOnly.start), dateKey(dueOnly.end));

  const reversed = calendarTaskRange({
    startAt: new Date(2026, 10, 21),
    dueAt: new Date(2026, 10, 19)
  });
  assert.equal(dateKey(reversed.start), "2026-11-19");
  assert.equal(dateKey(reversed.end), "2026-11-21");
});
