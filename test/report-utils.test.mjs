import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDateRangeReport, getCategoryStats, getDashboardMetrics, getProgressBuckets, taskProgress
} from "../js/report-utils.mjs";
import { buildExcelXmlWorkbook } from "../js/report-export.mjs";

test("dashboard metrics classify partially completed tasks as in progress", () => {
  const now = new Date(2026, 10, 20, 12);
  const metrics = getDashboardMetrics([
    { id: "done", status: "completed" },
    { id: "doing", status: "pending", checklist: [{ completed: true }, { completed: false }] },
    { id: "todo", status: "pending" },
    { id: "late", status: "pending", dueAt: new Date(2026, 10, 19, 12) },
    { id: "trash", status: "pending", deletedAt: now }
  ], now);
  assert.deepEqual(metrics, {
    total: 4, completed: 1, inProgress: 1, dueToday: 0, overdue: 1
  });
  assert.equal(taskProgress({ status: "pending", checklist: [{ completed: true }, { completed: false }] }), 50);
});

test("dashboard deadlines use the exact current time", () => {
  const now = new Date(2026, 10, 20, 12);
  const metrics = getDashboardMetrics([
    { status: "pending", dueAt: new Date(2026, 10, 20, 11, 59) },
    { status: "pending", dueAt: new Date(2026, 10, 20, 12, 1) },
    { status: "completed", dueAt: new Date(2026, 10, 20, 11) }
  ], now);
  assert.equal(metrics.overdue, 1);
  assert.equal(metrics.dueToday, 1);
});

test("category totals and weekly/monthly progress exclude deleted tasks", () => {
  const tasks = [
    { category: "Cá nhân", createdAt: new Date(2026, 10, 19), completedAt: new Date(2026, 10, 20), status: "completed" },
    { category: "Cá nhân", createdAt: new Date(2026, 10, 20), status: "pending" },
    { category: "IT", deletedAt: 1, createdAt: new Date(2026, 10, 20), status: "pending" }
  ];
  assert.deepEqual(getCategoryStats(tasks), [
    { name: "Cá nhân", total: 2, completed: 1 }
  ]);
  assert.equal(getProgressBuckets(tasks, "week", new Date(2026, 10, 20)).find(bucket => bucket.start.getDate() === 20).created, 1);
  assert.equal(getProgressBuckets(tasks, "month", new Date(2026, 10, 20))[2].created, 2);
});

test("monthly progress buckets end on the actual last day of the month", () => {
  const february = getProgressBuckets([], "month", new Date(2027, 1, 15));
  const january = getProgressBuckets([], "month", new Date(2027, 0, 15));
  assert.equal(february.length, 4);
  assert.equal(february.at(-1).label, "22–28");
  assert.equal(january.length, 5);
  assert.equal(january.at(-1).label, "29–31");
});

test("date-range reports calculate due completion rate and overdue state at period end", () => {
  const tasks = [
    { id: "done-on-time", title: "Done", status: "completed", dueAt: "2026-11-18T10:00:00", completedAt: "2026-11-19T10:00:00" },
    { id: "done-later", title: "Late done", status: "completed", dueAt: "2026-11-19T10:00:00", completedAt: "2026-11-22T10:00:00" },
    { id: "overdue", title: "Overdue", status: "pending", dueAt: "2026-11-17T10:00:00" },
    { id: "trash", title: "Deleted", status: "pending", deletedAt: 1, dueAt: "2026-11-17T10:00:00" }
  ];
  const report = buildDateRangeReport(tasks, new Date(2026, 10, 18), new Date(2026, 10, 20));
  assert.equal(report.dueInRange.length, 2);
  assert.equal(report.completedDueByEnd.length, 1);
  assert.equal(report.completionRate, 50);
  assert.deepEqual(report.overdueAtEnd.map(task => task.id).sort(), ["done-later", "overdue"]);
  assert.equal(buildDateRangeReport(tasks, new Date(2026, 10, 21), new Date(2026, 10, 20)), null);
});

test("Excel XML workbook escapes cell values and emits multiple worksheets", () => {
  const workbook = buildExcelXmlWorkbook([
    { name: "Summary", rows: [["A&B", 2]] },
    { name: "Tasks", rows: [["<Task>", "done"]] }
  ]);
  assert.match(workbook, /A&amp;B/);
  assert.match(workbook, /&lt;Task&gt;/);
  assert.match(workbook, /ss:Name="Summary"/);
  assert.match(workbook, /ss:Name="Tasks"/);
});
