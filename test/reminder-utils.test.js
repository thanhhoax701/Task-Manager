const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDueDailyReports,
  getReminderNotification,
  nextWorkdayStartAfter
} = require("../api/reminder-utils");

const now = Date.parse("2026-11-19T10:00:00.000Z");

for (const minutes of [5, 15, 30, 60]) {
  test(`selects the ${minutes}-minute reminder at its threshold`, () => {
    const dueAt = now + minutes * 60_000;
    assert.deepEqual(
      getReminderNotification({ dueAt: new Date(dueAt).toISOString(), remindBeforeMinutes: minutes }, now),
      { type: "before", dueAt, minutes }
    );
    assert.equal(
      getReminderNotification({ dueAt: new Date(dueAt + 1).toISOString(), remindBeforeMinutes: minutes }, now),
      null
    );
  });
}

test("sends a due reminder after the deadline, but only once", () => {
  const dueAt = now - 60_000;
  assert.deepEqual(
    getReminderNotification({ dueAt, preReminderSentAt: now }, now),
    { type: "due", dueAt, minutes: 0 }
  );
  assert.equal(getReminderNotification({ dueAt, reminderSentAt: now }, now), null);
});

test("skips completed, deleted, undated, and unselected future tasks", () => {
  const futureTask = { dueAt: new Date(now + 5 * 60_000).toISOString() };
  assert.equal(getReminderNotification({ ...futureTask, status: "completed", remindBeforeMinutes: 5 }, now), null);
  assert.equal(getReminderNotification({ ...futureTask, deletedAt: now, remindBeforeMinutes: 5 }, now), null);
  assert.equal(getReminderNotification({ remindBeforeMinutes: 5 }, now), null);
  assert.equal(getReminderNotification(futureTask, now), null);
});

test("does not resend an already-sent pre-reminder", () => {
  assert.equal(getReminderNotification({
    dueAt: new Date(now + 5 * 60_000).toISOString(),
    remindBeforeMinutes: 5,
    preReminderSentAt: now
  }, now), null);
});

test("sends morning and evening reports at the configured Vietnamese work times", () => {
  const nowAt = value => Date.parse(`2026-11-20T${value}:00.000+07:00`);
  assert.deepEqual(getDueDailyReports(nowAt("09:00"), { workStart: "09:00", workEnd: "18:00" }), [
    { type: "morning", date: "2026-11-20" }
  ]);
  assert.deepEqual(getDueDailyReports(nowAt("18:00"), {
    workStart: "09:00",
    workEnd: "18:00",
    morningReportSentDate: "2026-11-20"
  }), [{ type: "evening", date: "2026-11-20" }]);
});

test("snooze skips weekly days off and custom holidays", () => {
  const fridayEvening = Date.parse("2026-11-20T18:00:00+07:00");
  assert.equal(
    nextWorkdayStartAfter(fridayEvening, {
      workStart: "09:00",
      daysOff: "0,6",
      holidays: "2026-11-23"
    }),
    Date.parse("2026-11-24T09:00:00+07:00")
  );
});

test("snooze reports no available workday when every weekday is off", () => {
  assert.equal(nextWorkdayStartAfter(now, {
    daysOff: "0,1,2,3,4,5,6"
  }), null);
});