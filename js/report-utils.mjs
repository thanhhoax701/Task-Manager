import { asDate, dateKey, startOfDay } from "./calendar-utils.mjs";

export function taskProgress(task) {
  const checklist = task.checklist || [];
  const subtasks = task.subtasks || [];
  const total = checklist.length + subtasks.length;
  if (task.status === "completed") return 100;
  if (!total) return task.status === "in_progress" ? 1 : 0;
  const completed = checklist.filter(item => item.completed).length +
    subtasks.filter(item => item.status === "completed").length;
  return Math.round(completed / total * 100);
}

export function isTaskOverdue(task, now = new Date()) {
  const due = asDate(task.dueAt);
  return Boolean(!task.deletedAt && task.status !== "completed" &&
    due && due.getTime() < now.getTime());
}

export function getDashboardMetrics(tasks, now = new Date()) {
  const active = tasks.filter(task => !task.deletedAt);
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const completed = active.filter(task => task.status === "completed");
  const inProgress = active.filter(task =>
    task.status === "in_progress" ||
    (task.status !== "completed" && taskProgress(task) > 0)
  );
  const dueToday = active.filter(task => {
    const due = asDate(task.dueAt);
    return task.status !== "completed" && due && due >= now && due < tomorrow;
  });
  const overdue = active.filter(task => isTaskOverdue(task, now));
  return {
    total: active.length,
    completed: completed.length,
    inProgress: inProgress.length,
    dueToday: dueToday.length,
    overdue: overdue.length
  };
}

export function getCategoryStats(tasks) {
  const categories = new Map();
  for (const task of tasks) {
    if (task.deletedAt) continue;
    const name = String(task.category || "Khác").trim() || "Khác";
    const item = categories.get(name) || { name, total: 0, completed: 0 };
    item.total++;
    if (task.status === "completed") item.completed++;
    categories.set(name, item);
  }
  return [...categories.values()].sort((a, b) =>
    b.total - a.total || a.name.localeCompare(b.name, "vi")
  );
}

function makeBuckets(mode, referenceDate) {
  const anchor = startOfDay(referenceDate);
  if (mode === "week") {
    const monday = new Date(anchor);
    monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
    return Array.from({ length: 7 }, (_, index) => {
      const start = new Date(monday);
      start.setDate(monday.getDate() + index);
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      return {
        start,
        end,
        label: new Intl.DateTimeFormat("vi-VN", { weekday: "short" }).format(start)
      };
    });
  }

  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const monthEnd = new Date(year, month + 1, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: 5 }, (_, index) => {
    const start = new Date(year, month, index * 7 + 1);
    const end = new Date(year, month, Math.min(index * 7 + 8, daysInMonth + 1));
    return {
      start,
      end,
      label: `${start.getDate()}–${new Date(end.getTime() - 1).getDate()}`
    };
  }).filter(bucket => bucket.start < monthEnd);
}

export function getProgressBuckets(tasks, mode, referenceDate = new Date()) {
  const buckets = makeBuckets(mode, referenceDate).map(bucket => ({
    ...bucket,
    created: 0,
    completed: 0
  }));
  for (const task of tasks) {
    if (task.deletedAt) continue;
    const createdAt = asDate(task.createdAt);
    const completedAt = asDate(task.completedAt);
    for (const bucket of buckets) {
      if (createdAt && createdAt >= bucket.start && createdAt < bucket.end) bucket.created++;
      if (completedAt && completedAt >= bucket.start && completedAt < bucket.end) bucket.completed++;
    }
  }
  return buckets;
}

export function buildDateRangeReport(tasks, startDate, endDate) {
  const start = startOfDay(startDate);
  const endExclusive = startOfDay(endDate);
  endExclusive.setDate(endExclusive.getDate() + 1);
  if (start > endExclusive || startDate > endDate) return null;

  const active = tasks.filter(task => !task.deletedAt);
  const createdInRange = [];
  const dueInRange = [];
  const completedInRange = [];
  const overdueAtEnd = [];
  const related = new Map();
  const inRange = value => {
    const date = asDate(value);
    return date && date >= start && date < endExclusive;
  };

  for (const task of active) {
    const createdAt = asDate(task.createdAt);
    const dueAt = asDate(task.dueAt);
    const completedAt = asDate(task.completedAt) ||
      (task.status === "completed" ? asDate(task.updatedAt) : null);
    const created = inRange(createdAt);
    const due = inRange(dueAt);
    const completed = inRange(completedAt);
    const completedByEnd = task.status === "completed" &&
      (!completedAt || completedAt < endExclusive);
    const existedByEnd = !createdAt || createdAt < endExclusive;
    const overdue = existedByEnd && dueAt && dueAt < endExclusive && !completedByEnd;

    if (created) createdInRange.push(task);
    if (due) dueInRange.push(task);
    if (completed) completedInRange.push(task);
    if (overdue) overdueAtEnd.push(task);
    if (created || due || completed || overdue) related.set(task.id, task);
  }

  const completedDueByEnd = dueInRange.filter(task => {
    if (task.status !== "completed") return false;
    const completedAt = asDate(task.completedAt) || asDate(task.updatedAt);
    return !completedAt || completedAt < endExclusive;
  });
  return {
    start,
    end: new Date(endExclusive.getTime() - 1),
    createdInRange,
    dueInRange,
    completedInRange,
    completedDueByEnd,
    overdueAtEnd,
    tasks: [...related.values()].sort((a, b) =>
      (asDate(a.dueAt)?.getTime() || Infinity) - (asDate(b.dueAt)?.getTime() || Infinity) ||
      String(a.title || "").localeCompare(String(b.title || ""), "vi")
    ),
    completionRate: dueInRange.length
      ? Math.round(completedDueByEnd.length / dueInRange.length * 100)
      : null,
    startKey: dateKey(start),
    endKey: dateKey(new Date(endExclusive.getTime() - 1))
  };
}
