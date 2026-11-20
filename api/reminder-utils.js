const REMINDER_MINUTES = [5, 15, 30, 60];
const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";
const VIETNAM_OFFSET_MS = 7 * 60 * 60_000;

function timestampMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getReminderNotification(task, now) {
  if (!task || task.deletedAt || task.status === "completed") return null;
  const dueAt = timestampMillis(task.dueAt);
  if (dueAt === null) return null;

  if (dueAt <= now) {
    return task.reminderSentAt ? null : { type: "due", dueAt, minutes: 0 };
  }

  const minutes = Number(task.remindBeforeMinutes);
  if (!REMINDER_MINUTES.includes(minutes) || task.preReminderSentAt ||
      dueAt - minutes * 60_000 > now) return null;
  return { type: "before", dueAt, minutes };
}

function vietnamDateAndMinute(value) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: VIETNAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type)?.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute"))
  };
}

function parseClock(value, fallback) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

function getDueDailyReports(now, settings = {}) {
  const local = vietnamDateAndMinute(now);
  const morningKey = `morningReportSentDate`;
  const eveningKey = `eveningReportSentDate`;
  const morningTime = parseClock(settings.workStart, 9 * 60);
  const eveningTime = parseClock(settings.workEnd, 17 * 60);
  const due = [];
  if (local.minute >= morningTime && settings[morningKey] !== local.date) due.push("morning");
  if (local.minute >= eveningTime && settings[eveningKey] !== local.date) due.push("evening");
  return due.map(type => ({ type, date: local.date }));
}

function settingList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value ? value.split(",") : [];
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length && entries.every(([, entry]) => entry === true)
      ? entries.map(([key]) => key)
      : entries.map(([, entry]) => entry);
  }
  return [];
}

function nextWorkdayStartAfter(timestamp, settings = {}) {
  const workStart = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(settings.workStart || "09:00") || [null, "09", "00"];
  const daysOff = new Set(settingList(settings.daysOff)
    .map(Number)
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6));
  const holidays = new Set(settingList(settings.holidays)
    .filter(date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)));
  const local = new Date(timestamp + VIETNAM_OFFSET_MS);

  for (let dayOffset = 1; dayOffset <= 370; dayOffset++) {
    const date = new Date(Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + dayOffset
    ));
    const dateKey = [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0")
    ].join("-");
    if (daysOff.has(date.getUTCDay()) || holidays.has(dateKey)) continue;

    const workdayStart = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      Number(workStart[1]),
      Number(workStart[2])
    ) - VIETNAM_OFFSET_MS;
    if (workdayStart > timestamp) return workdayStart;
  }
  return null;
}

module.exports = {
  getDueDailyReports,
  getReminderNotification,
  nextWorkdayStartAfter,
  timestampMillis,
  vietnamDateAndMinute
};