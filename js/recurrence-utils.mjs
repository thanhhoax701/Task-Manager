const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const RECURRENCE_TYPES = new Set(["daily", "weekly", "monthly", "yearly"]);

function toDate(value) {
  if (value == null || value === "") return null;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function nextDueAt(value, recurrence, anchor = {}) {
  const due = toDate(value);
  if (!due || !RECURRENCE_TYPES.has(recurrence)) return null;

  const local = new Date(due.getTime() + VIETNAM_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  if (recurrence === "daily") local.setUTCDate(day + 1);
  if (recurrence === "weekly") local.setUTCDate(day + 7);
  if (recurrence === "monthly") {
    const targetMonth = (month + 1) % 12;
    const targetYear = year + (month === 11 ? 1 : 0);
    const targetDay = Math.min(Number(anchor.day) || day, daysInMonth(targetYear, targetMonth));
    local.setUTCFullYear(targetYear, targetMonth, targetDay);
  }
  if (recurrence === "yearly") {
    const targetYear = year + 1;
    const targetMonth = anchor.month != null && Number.isInteger(Number(anchor.month))
      ? Number(anchor.month)
      : month;
    const targetDay = Math.min(Number(anchor.day) || day, daysInMonth(targetYear, targetMonth));
    local.setUTCFullYear(targetYear, targetMonth, targetDay);
  }

  return new Date(local.getTime() - VIETNAM_OFFSET_MS).toISOString();
}

export function buildNextOccurrence(task, taskId, now = Date.now()) {
  const dueAt = nextDueAt(task.dueAt, task.recurrence, {
    day: task.recurrenceAnchorDay,
    month: task.recurrenceAnchorMonth
  });
  if (!dueAt) return null;

  const previousDue = toDate(task.dueAt);
  const nextDue = new Date(dueAt);
  const start = toDate(task.startAt);
  const {
    id, createdAt, updatedAt, deletedAt, completedAt,
    recurrenceNextTaskId, notificationClaimedAt, notificationClaimedType,
    reminderSentAt, preReminderSentAt, ...copy
  } = task;
  return {
    ...copy,
    id: taskId,
    status: "pending",
    deletedAt: null,
    completedAt: null,
    dueAt,
    startAt: start && previousDue
      ? new Date(start.getTime() + nextDue.getTime() - previousDue.getTime()).toISOString()
      : null,
    reminderSentAt: null,
    preReminderSentAt: null,
    notificationClaimedAt: null,
    notificationClaimedType: null,
    recurrenceCount: Number(task.recurrenceCount || 0),
    checklist: (task.checklist || []).map(item => ({ ...item, completed: false })),
    subtasks: (task.subtasks || []).map(item => ({ ...item, status: "pending" })),
    tags: (task.tags || []).map(tag => ({ ...tag })),
    attachments: (task.attachments || []).filter(attachment => attachment.kind === "link"),
    createdAt: now,
    updatedAt: now
  };
}
