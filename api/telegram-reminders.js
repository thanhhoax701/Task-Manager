const { timingSafeEqual } = require("node:crypto");
const { getFirebaseServices } = require("./firebase-admin");
const { logNotification } = require("./telegram-logs");
const {
  getDueDailyReports, getReminderNotification, timestampMillis, vietnamDateAndMinute
} = require("./reminder-utils");

const VIETNAM_OFFSET_MS = 7 * 60 * 60_000;

function isAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.authorization;
  if (!secret || typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorization);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function sendTelegramMessage(token, chatId, text, replyMarkup) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }),
    signal: AbortSignal.timeout(10_000)
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram API returned HTTP ${response.status}.`);
  }
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API error: ${result.description || response.statusText}`);
  }
}

function formatVietnamDate(value) {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh"
  }).format(new Date(value));
}

function localDayBounds(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const start = Date.UTC(year, month - 1, day) - VIETNAM_OFFSET_MS;
  return { start, end: start + 24 * 60 * 60_000 };
}

function taskTimestamp(value) {
  return timestampMillis(value);
}

function taskLine(task, includeTime = true) {
  const due = taskTimestamp(task.dueAt);
  const suffix = includeTime && due != null ? ` — ${formatVietnamDate(due)}` : "";
  return `• ${task.title || "Công việc"}${suffix}`;
}

function buildDailyReport(type, dateKey, tasks, now) {
  const { start, end } = localDayBounds(dateKey);
  const active = Object.values(tasks || {}).filter(task => task && !task.deletedAt);
  const dueToday = active
    .filter(task => task.status !== "completed")
    .filter(task => {
      const due = taskTimestamp(task.dueAt);
      return due != null && due >= start && due < end;
    })
    .sort((a, b) => taskTimestamp(a.dueAt) - taskTimestamp(b.dueAt));
  const overdue = active
    .filter(task => task.status !== "completed")
    .filter(task => {
      const due = taskTimestamp(task.dueAt);
      return due != null && due < start;
    })
    .sort((a, b) => taskTimestamp(a.dueAt) - taskTimestamp(b.dueAt));
  const completedToday = active
    .filter(task => task.status === "completed")
    .filter(task => {
      const completed = taskTimestamp(task.completedAt || task.updatedAt);
      return completed != null && completed >= start && completed < end;
    })
    .sort((a, b) => taskTimestamp(b.completedAt || b.updatedAt) - taskTimestamp(a.completedAt || a.updatedAt));

  const sections = type === "morning"
    ? [
      ["QUÁ HẠN", overdue],
      ["HÔM NAY", dueToday]
    ]
    : [
      ["ĐÃ HOÀN THÀNH", completedToday],
      ["CHƯA XONG HÔM NAY", dueToday],
      ["QUÁ HẠN", overdue]
    ];
  const lines = [
    type === "morning" ? `☀️ BÁO CÁO ĐẦU NGÀY · ${dateKey}` : `🌙 BÁO CÁO CUỐI NGÀY · ${dateKey}`,
    ""
  ];
  for (const [heading, sectionTasks] of sections) {
    lines.push(`${heading} (${sectionTasks.length})`);
    lines.push(...(sectionTasks.length ? sectionTasks.slice(0, 15).map(task => taskLine(task)) : ["• Không có"]));
    if (sectionTasks.length > 15) lines.push(`…và ${sectionTasks.length - 15} việc khác`);
    lines.push("");
  }
  lines.push(`Cập nhật lúc ${formatVietnamDate(now)}.`);
  return lines.join("\n").slice(0, 3900);
}

function reminderKeyboard(uid, taskId) {
  return {
    inline_keyboard: [[
      { text: "✅ Hoàn thành", callback_data: `done:${uid}:${taskId}` },
      { text: "⏰ +1 giờ", callback_data: `snooze1h:${uid}:${taskId}` },
      { text: "🌅 Ngày làm việc", callback_data: `tomorrow:${uid}:${taskId}` }
    ]]
  };
}

async function cleanupExpiredLinkCodes(database, now) {
  const expired = await database.ref("telegramLinkCodes")
    .orderByChild("expiresAt")
    .endAt(now)
    .get();
  const codes = Object.keys(expired.val() || {});
  if (codes.length) {
    const updates = Object.fromEntries(codes.map(code => [`telegramLinkCodes/${code}`, null]));
    await database.ref().update(updates);
  }
}

async function sendTaskReminder(database, token, uid, chatId, taskId, task, notification, now) {
  const { type, dueAt, minutes } = notification;
  const dueText = formatVietnamDate(dueAt);
  const priorities = { high: "Cao", medium: "Trung bình", low: "Thấp" };
  const overdue = type === "due" && dueAt < now;
  const text = [
    type === "before"
      ? "⏰ NHẮC TRƯỚC HẠN"
      : overdue ? "⚠️ CÔNG VIỆC QUÁ HẠN" : "🔔 CÔNG VIỆC ĐẾN HẠN",
    "",
    `📌 ${task.title || "Công việc"}`,
    task.description ? `📝 ${task.description}` : "",
    `📂 Danh mục: ${task.category || "Khác"}`,
    `⚡ Ưu tiên: ${priorities[task.priority] || "Trung bình"}`,
    `🕒 Thời hạn: ${dueText}`,
    type === "before" ? `⏳ Còn ${minutes} phút đến hạn.` : ""
  ].filter(Boolean).join("\n").slice(0, 3900);
  const log = {
    type: overdue ? "overdue" : type === "before" ? "before" : "due",
    status: "success",
    taskId,
    taskTitle: task.title || "Công việc",
    message: text.slice(0, 1000)
  };

  try {
    await sendTelegramMessage(token, chatId, text, reminderKeyboard(uid, taskId));
  } catch (error) {
    console.error(`Failed Telegram reminder for task ${taskId}:`, error);
    await database.ref(`users/${uid}/tasks/${taskId}`).update({
      notificationClaimedAt: null,
      notificationClaimedType: null
    });
    await logNotification(database, uid, {
      ...log,
      status: "failed",
      error: String(error.message || error).slice(0, 250)
    });
    return false;
  }

  await database.ref(`users/${uid}/tasks/${taskId}`).update({
    [type === "before" ? "preReminderSentAt" : "reminderSentAt"]: Date.now(),
    notificationClaimedAt: null,
    notificationClaimedType: null
  });
  await logNotification(database, uid, log);
  return true;
}

async function sendDailyReport(database, token, uid, chatId, type, date, tasks, now) {
  const stateRef = database.ref(`users/${uid}/settings/telegramReportState/${type}`);
  const claim = await stateRef.transaction(current => {
    if (current?.date === date && current.status === "sent") return;
    if (current?.date === date && current.status === "sending" && now - current.claimedAt < 120_000) return;
    return { date, status: "sending", claimedAt: now };
  });
  if (!claim.committed) return "skipped";

  const text = buildDailyReport(type, date, tasks, now);
  try {
    await sendTelegramMessage(token, chatId, text);
  } catch (error) {
    console.error(`Failed ${type} report for user ${uid}:`, error);
    await stateRef.set({ date, status: "failed", failedAt: Date.now() });
    await logNotification(database, uid, {
      type: `report_${type}`,
      status: "failed",
      message: text.slice(0, 1000),
      error: String(error.message || error).slice(0, 250)
    });
    return "failed";
  }

  await stateRef.set({ date, status: "sent", sentAt: Date.now() });
  await database.ref(`users/${uid}/settings`).update({
    [`${type}ReportSentDate`]: date
  });
  await logNotification(database, uid, {
    type: `report_${type}`,
    status: "success",
    message: text.slice(0, 1000)
  });
  return "sent";
}

module.exports = async function telegramReminders(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed." });
  }
  if (!isAuthorized(request)) {
    return response.status(401).json({ error: "Unauthorized." });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return response.status(500).json({ error: "Telegram bot token is missing." });

  try {
    const { database, firestore } = getFirebaseServices();
    const now = Date.now();
    await cleanupExpiredLinkCodes(database, now);
    const scanUntilIso = new Date(now + 60 * 60_000).toISOString();
    const users = await firestore.collection("users").select("email").get();
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const user of users.docs) {
      const userRef = database.ref(`users/${user.id}`);
      const settings = (await userRef.child("settings").get()).val() || {};
      const chatId = settings.telegramChatId;
      if (!/^-?\d+$/.test(String(chatId || ""))) {
        skipped++;
        continue;
      }
      const owner = (await database.ref(`telegramChatOwners/${chatId}`).get()).val();
      if (owner !== user.id) {
        skipped++;
        continue;
      }

      const tasksRef = userRef.child("tasks");
      const dueSnapshot = await tasksRef.orderByChild("dueAt")
        .startAt("0000")
        .endAt(scanUntilIso)
        .get();
      const dueTasks = dueSnapshot.val() || {};
      for (const [taskId, indexedTask] of Object.entries(dueTasks)) {
        const notification = getReminderNotification(indexedTask, now);
        if (!notification) continue;

        const { type, dueAt, minutes } = notification;
        const taskRef = tasksRef.child(taskId);
        const claim = await taskRef.transaction(current => {
          if (!current || current.status === "completed" || current.deletedAt ||
              (current.notificationClaimedAt && now - current.notificationClaimedAt < 120_000)) return;
          if (type === "due" ? current.reminderSentAt : current.preReminderSentAt) return;
          if (timestampMillis(current.dueAt) !== dueAt) return;
          if (type === "before" && Number(current.remindBeforeMinutes) !== minutes) return;
          return {
            ...current,
            notificationClaimedAt: now,
            notificationClaimedType: type
          };
        });
        if (!claim.committed || !claim.snapshot.exists()) continue;
        if (await sendTaskReminder(database, botToken, user.id, chatId, taskId, claim.snapshot.val(), notification, now)) {
          sent++;
        } else {
          failed++;
        }
      }

      const dueReports = getDueDailyReports(now, settings);
      if (dueReports.length) {
        const allTasks = (await tasksRef.get()).val() || {};
        for (const report of dueReports) {
          const result = await sendDailyReport(
            database, botToken, user.id, chatId, report.type, report.date, allTasks, now
          );
          if (result === "sent") sent++;
          if (result === "failed") failed++;
          if (result === "skipped") skipped++;
        }
      }
    }

    const { date } = vietnamDateAndMinute(now);
    return response.status(failed ? 500 : 200).json({ ok: failed === 0, date, sent, failed, skipped });
  } catch (error) {
    console.error("Telegram reminder cron failed:", error);
    return response.status(500).json({ error: "Reminder job failed." });
  }
};
