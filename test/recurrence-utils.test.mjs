import test from "node:test";
import assert from "node:assert/strict";
import { buildNextOccurrence, nextDueAt } from "../js/recurrence-utils.mjs";

test("daily and weekly recurrence preserve Vietnam local time", () => {
  const dueAt = "2026-11-20T02:30:00.000Z";
  assert.equal(nextDueAt(dueAt, "daily"), "2026-11-21T02:30:00.000Z");
  assert.equal(nextDueAt(dueAt, "weekly"), "2026-11-27T02:30:00.000Z");
});

test("monthly recurrence clamps at the month end and returns to the anchor day", () => {
  const dueAt = "2026-01-30T02:00:00.000Z";
  const february = nextDueAt(dueAt, "monthly", { day: 30 });
  assert.equal(february, "2026-02-28T02:00:00.000Z");
  assert.equal(nextDueAt(february, "monthly", { day: 30 }), "2026-03-30T02:00:00.000Z");
});

test("yearly recurrence clamps leap day in a non-leap year", () => {
  assert.equal(
    nextDueAt("2024-02-28T17:00:00.000Z", "yearly", { month: 1, day: 29 }),
    "2025-02-27T17:00:00.000Z"
  );
});

test("next occurrence resets status and reminders while preserving task details", () => {
  const next = buildNextOccurrence({
    title: "Lặp",
    status: "completed",
    dueAt: "2026-11-20T02:00:00.000Z",
    startAt: "2026-11-19T02:00:00.000Z",
    recurrence: "daily",
    remindBeforeMinutes: 15,
    reminderSentAt: 123,
    preReminderSentAt: 123,
    checklist: [{ id: "c1", title: "Bước", completed: true }],
    subtasks: [{ id: "s1", title: "Việc con", status: "completed" }],
    attachments: [
      { id: "link", kind: "link", name: "Link", url: "https://example.com" },
      { id: "file", kind: "file", path: "users/u/tasks/t/file" }
    ]
  }, "next-id", 1_000);

  assert.equal(next.id, "next-id");
  assert.equal(next.status, "pending");
  assert.equal(next.dueAt, "2026-11-21T02:00:00.000Z");
  assert.equal(next.startAt, "2026-11-20T02:00:00.000Z");
  assert.equal(next.reminderSentAt, null);
  assert.equal(next.preReminderSentAt, null);
  assert.equal(next.checklist[0].completed, false);
  assert.equal(next.subtasks[0].status, "pending");
  assert.deepEqual(next.attachments.map(item => item.id), ["link"]);
});

test("invalid dates and non-repeating tasks do not produce another occurrence", () => {
  assert.equal(nextDueAt(null, "daily"), null);
  assert.equal(nextDueAt("bad-date", "daily"), null);
  assert.equal(nextDueAt("2026-11-20T02:00:00.000Z", "none"), null);
});
