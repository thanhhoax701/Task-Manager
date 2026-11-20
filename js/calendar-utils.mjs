export function asDate(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dayOrdinal(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function mondayOf(date) {
  const monday = startOfDay(date);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return monday;
}

export function calendarTaskRange(task) {
  const start = asDate(task.startAt) || asDate(task.dueAt);
  const end = asDate(task.dueAt) || start;
  if (!start || !end) return null;
  return dayOrdinal(start) <= dayOrdinal(end)
    ? { start: startOfDay(start), end: startOfDay(end) }
    : { start: startOfDay(end), end: startOfDay(start) };
}

export function getCalendarDays(mode, anchorDate) {
  const anchor = startOfDay(anchorDate);
  if (mode === "day") return [anchor];
  if (mode === "week") {
    const start = mondayOf(anchor);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }

  const firstDay = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const lastDay = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const firstWeek = mondayOf(firstDay);
  const lastWeek = mondayOf(lastDay);
  const count = dayOrdinal(lastWeek) - dayOrdinal(firstWeek) + 7;
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(firstWeek);
    date.setDate(firstWeek.getDate() + index);
    return date;
  });
}

export function shiftTaskSchedule(task, sourceDateKey, targetDate) {
  const sourceDate = dateFromKey(sourceDateKey);
  const dayDelta = dayOrdinal(targetDate) - dayOrdinal(sourceDate);
  if (!dayDelta) return null;

  const shift = value => {
    const date = asDate(value);
    if (!date) return null;
    date.setDate(date.getDate() + dayDelta);
    return date;
  };
  return {
    startAt: shift(task.startAt),
    dueAt: shift(task.dueAt)
  };
}
