const { timingSafeEqual } = require("node:crypto");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getFirestore } = require("firebase-admin/firestore");

const ADMIN_APP_NAME = "task-manager-vercel-reminders";
const DATABASE_URL = "https://taskmanager-83fd6-default-rtdb.firebaseio.com";

function isAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.authorization;
  if (!secret || typeof authorization !== "string") return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorization);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function getFirebaseServices() {
  let app = getApps().find(candidate => candidate.name === ADMIN_APP_NAME);
  if (!app) {
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!rawServiceAccount) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT.");
    app = initializeApp({
      credential: cert(JSON.parse(rawServiceAccount)),
      databaseURL: process.env.FIREBASE_DATABASE_URL || DATABASE_URL
    }, ADMIN_APP_NAME);
  }
  return {
    database: getDatabase(app),
    firestore: getFirestore(app)
  };
}

function timestampMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function sendTelegramMessage(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
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

module.exports = async function telegramReminders(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed." });
  }
  if (!isAuthorized(request)) {
    return response.status(401).json({ error: "Unauthorized." });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return response.status(500).json({ error: "Telegram environment variables are missing." });
  }

  try {
    const { database, firestore } = getFirebaseServices();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const users = await firestore.collection("users").select("email").get();
    let sent = 0;
    let failed = 0;

    for (const user of users.docs) {
      const dueSnapshot = await database.ref(`users/${user.id}/tasks`)
        .orderByChild("dueAt")
        .startAt("0000")
        .endAt(nowIso)
        .get();
      const tasks = dueSnapshot.val();
      if (!tasks) continue;

      for (const [taskId, indexedTask] of Object.entries(tasks)) {
        const dueAt = timestampMillis(indexedTask.dueAt);
        if (dueAt === null || dueAt > now) continue;

        const taskRef = database.ref(`users/${user.id}/tasks/${taskId}`);
        const claim = await taskRef.transaction(current => {
          if (!current || current.status === "completed" || current.deletedAt ||
              current.reminderSentAt ||
              (current.notificationClaimedAt && now - current.notificationClaimedAt < 120_000)) return;
          if (timestampMillis(current.dueAt) !== dueAt) return;
          return { ...current, notificationClaimedAt: now };
        });
        if (!claim.committed || !claim.snapshot.exists()) continue;

        const task = claim.snapshot.val();
        const dueText = new Intl.DateTimeFormat("vi-VN", {
          dateStyle: "short",
          timeStyle: "short",
          timeZone: "Asia/Ho_Chi_Minh"
        }).format(new Date(dueAt));
        const priorities = { high: "Cao", medium: "Trung bình", low: "Thấp" };
        const text = [
          "🔔 NHẮC VIỆC",
          "",
          `📌 ${task.title || "Công việc"}`,
          task.description ? `📝 ${task.description}` : "",
          `📂 Danh mục: ${task.category || "Khác"}`,
          `⚡ Ưu tiên: ${priorities[task.priority] || "Trung bình"}`,
          `🕒 Thời hạn: ${dueText}`,
          "",
          "Mở Task Manager để cập nhật trạng thái."
        ].filter(Boolean).join("\n");

        try {
          await sendTelegramMessage(botToken, chatId, text);
          await taskRef.update({
            reminderSentAt: Date.now(),
            notificationClaimedAt: null
          });
          sent++;
        } catch (error) {
          console.error(`Failed Telegram reminder for task ${taskId}:`, error);
          await taskRef.update({ notificationClaimedAt: null });
          failed++;
        }
      }
    }

    return response.status(failed ? 500 : 200).json({ ok: failed === 0, sent, failed });
  } catch (error) {
    console.error("Telegram reminder cron failed:", error);
    return response.status(500).json({ error: "Reminder job failed." });
  }
};
