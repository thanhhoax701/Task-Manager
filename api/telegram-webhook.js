const { createHash, timingSafeEqual } = require("node:crypto");
const { getFirebaseServices } = require("./firebase-admin");
const { logNotification } = require("./telegram-logs");
const { nextWorkdayStartAfter } = require("./reminder-utils");

const RECURRENCE_TYPES = new Set(["daily", "weekly", "monthly", "yearly"]);

function hasSecret(request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const received = request.headers["x-telegram-bot-api-secret-token"];
  if (!secret || typeof received !== "string") return false;
  const expectedBuffer = Buffer.from(secret);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function telegramRequest(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API error: ${result.description || response.statusText}`);
  }
  return result.result;
}

async function sendReply(token, chatId, text) {
  return telegramRequest(token, "sendMessage", { chat_id: chatId, text });
}

async function linkChat(database, chatId, code) {
  const hash = createHash("sha256").update(code).digest("hex");
  const codeRef = database.ref(`telegramLinkCodes/${hash}`);
  const codeSnapshot = await codeRef.get();
  const link = codeSnapshot.val();
  if (!link || link.expiresAt <= Date.now()) return "Liên kết không hợp lệ hoặc đã hết hạn. Hãy tạo mã mới trong Cài đặt.";

  const settingsRef = database.ref(`users/${link.uid}/settings`);
  const settings = (await settingsRef.get()).val() || {};
  if (settings.telegramPendingLinkHash !== hash ||
      Number(settings.telegramPendingLinkExpiresAt) <= Date.now()) {
    return "Mã liên kết đã hết hạn. Hãy tạo mã mới trong Cài đặt.";
  }

  const ownerRef = database.ref(`telegramChatOwners/${chatId}`);
  const currentOwner = (await ownerRef.get()).val();
  if (currentOwner && currentOwner !== link.uid) {
    return "Tài khoản Telegram này đã được liên kết với một tài khoản Task Manager khác.";
  }
  const ownership = await ownerRef.transaction(current =>
    current && current !== link.uid ? undefined : link.uid
  );
  if (!ownership.committed) return "Không thể liên kết chat Telegram này.";

  const claim = await codeRef.transaction(current => {
    if (!current || current.uid !== link.uid || current.expiresAt <= Date.now() ||
        (current.consumedBy && String(current.consumedBy) !== String(chatId))) return;
    return { ...current, consumedBy: String(chatId), consumedAt: current.consumedAt || Date.now() };
  });
  if (!claim.committed) {
    if (!currentOwner) {
      await ownerRef.transaction(current => current === link.uid ? null : current);
    }
    return "Mã liên kết đã được sử dụng hoặc hết hạn. Hãy tạo mã mới.";
  }

  await settingsRef.update({
    telegramChatId: String(chatId),
    telegramLinkedAt: Date.now(),
    telegramPendingLinkHash: null,
    telegramPendingLinkExpiresAt: null
  });
  if (/^-?\d+$/.test(String(settings.telegramChatId || "")) &&
      String(settings.telegramChatId) !== String(chatId)) {
    const previousOwnerRef = database.ref(`telegramChatOwners/${settings.telegramChatId}`);
    await previousOwnerRef.transaction(current => current === link.uid ? null : current);
  }
  await codeRef.remove();
  return "Đã liên kết Telegram với tài khoản Task Manager này. Bạn sẽ nhận nhắc việc và có thể thao tác trực tiếp tại đây.";
}

async function unlinkChat(database, chatId) {
  const ownerRef = database.ref(`telegramChatOwners/${chatId}`);
  const uid = (await ownerRef.get()).val();
  if (!uid) return "Chat Telegram này chưa được liên kết.";
  const settingsRef = database.ref(`users/${uid}/settings`);
  const settings = (await settingsRef.get()).val() || {};
  if (String(settings.telegramChatId) !== String(chatId)) {
    throw new Error("Telegram chat ownership data is inconsistent.");
  }
  const updates = {
    [`users/${uid}/settings/telegramChatId`]: null,
    [`users/${uid}/settings/telegramLinkedAt`]: null,
    [`telegramChatOwners/${chatId}`]: null
  };
  if (/^[a-f0-9]{64}$/.test(settings.telegramPendingLinkHash || "")) {
    updates[`telegramLinkCodes/${settings.telegramPendingLinkHash}`] = null;
    updates[`users/${uid}/settings/telegramPendingLinkHash`] = null;
    updates[`users/${uid}/settings/telegramPendingLinkExpiresAt`] = null;
  }
  await database.ref().update(updates);
  return "Đã ngắt liên kết Telegram.";
}

function normalizeItems(value, type) {
  if (!value) return [];
  return Object.entries(value).map(([id, item]) => ({
    id,
    ...(item && typeof item === "object" ? item : { title: String(item) }),
    ...(type === "checklist" ? { completed: true } : { status: "completed" })
  }));
}

async function completeTask(database, uid, taskId) {
  const taskRef = database.ref(`users/${uid}/tasks/${taskId}`);
  const proposedNextTaskId = database.ref(`users/${uid}/tasks`).push().key;
  const now = Date.now();
  const result = await taskRef.transaction(current => {
    if (!current || current.deletedAt) return;
    const recurrence = RECURRENCE_TYPES.has(current.recurrence) && current.dueAt;
    const recurrenceCount = Number(current.recurrenceCount || 0) +
      (recurrence && !current.recurrenceNextTaskId ? 1 : 0);
    const nextTaskId = current.recurrenceNextTaskId ||
      (recurrence ? proposedNextTaskId : null);
    return {
      ...current,
      status: "completed",
      completedAt: current.completedAt || now,
      updatedAt: now,
      checklist: Object.fromEntries(normalizeItems(current.checklist, "checklist").map(item => [item.id, item])),
      subtasks: Object.fromEntries(normalizeItems(current.subtasks, "subtask").map(item => [item.id, item])),
      ...(nextTaskId ? { recurrenceCount, recurrenceNextTaskId: nextTaskId } : {})
    };
  });
  const task = result.snapshot.val();
  if (!result.committed || !task || task.deletedAt) return { ok: false, message: "Công việc không còn khả dụng." };

  if (task.recurrenceNextTaskId) {
    const { buildNextOccurrence } = await import("../js/recurrence-utils.mjs");
    const checklist = normalizeItems(task.checklist, "checklist").map(({ id, completed, ...item }) => ({
      id, ...item, completed: true
    }));
    const subtasks = normalizeItems(task.subtasks, "subtask").map(({ id, status, ...item }) => ({
      id, ...item, status: "completed"
    }));
    const built = buildNextOccurrence({ ...task, checklist, subtasks }, task.recurrenceNextTaskId, now);
    if (built) {
      const { id, ...nextTask } = built;
      const serializeItems = items => items.length
        ? Object.fromEntries(items.map((item, index) => [item.id || String(index), item]))
        : null;
      nextTask.checklist = serializeItems(nextTask.checklist);
      nextTask.subtasks = serializeItems(nextTask.subtasks);
      nextTask.tags = serializeItems(nextTask.tags);
      nextTask.attachments = serializeItems(nextTask.attachments);
      await database.ref(`users/${uid}/tasks/${id}`).transaction(current => current || nextTask);
    }
  }
  return { ok: true, task };
}

async function snoozeTask(database, uid, taskId, action) {
  const taskRef = database.ref(`users/${uid}/tasks/${taskId}`);
  const settings = (await database.ref(`users/${uid}/settings`).get()).val() || {};
  const now = Date.now();
  let noWorkday = false;
  const result = await taskRef.transaction(current => {
    noWorkday = false;
    if (!current || current.deletedAt || current.status === "completed") return;
    const previousDue = timestampMillis(current.dueAt);
    if (previousDue == null) return;
    const nextWorkday = action === "tomorrow"
      ? nextWorkdayStartAfter(Math.max(now, previousDue), settings)
      : null;
    if (action === "tomorrow" && nextWorkday == null) {
      noWorkday = true;
      return;
    }
    const newDue = action === "snooze1h" ? new Date(now + 60 * 60_000) : new Date(nextWorkday);
    const startAt = timestampMillis(current.startAt);
    return {
      ...current,
      dueAt: newDue.toISOString(),
      startAt: startAt == null ? current.startAt || null : new Date(startAt + newDue.getTime() - previousDue).toISOString(),
      reminderSentAt: null,
      preReminderSentAt: now,
      notificationClaimedAt: null,
      notificationClaimedType: null,
      updatedAt: now
    };
  });
  return result.committed && result.snapshot.exists()
    ? { ok: true }
    : { ok: false, reason: noWorkday ? "no_workday" : null };
}

async function handleCallback(database, token, callback) {
  const [action, uid, taskId] = String(callback.data || "").split(":");
  const chatId = callback.message?.chat?.id;
  if (!["done", "snooze1h", "tomorrow"].includes(action) || !uid || !taskId || chatId == null) {
    await telegramRequest(token, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Thao tác không hợp lệ."
    });
    return;
  }

  const owner = (await database.ref(`telegramChatOwners/${chatId}`).get()).val();
  const linkedChat = (await database.ref(`users/${uid}/settings/telegramChatId`).get()).val();
  if (owner !== uid || String(linkedChat) !== String(chatId)) {
    await telegramRequest(token, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Chat này không có quyền cập nhật công việc."
    });
    return;
  }

  const outcome = action === "done"
    ? await completeTask(database, uid, taskId)
    : await snoozeTask(database, uid, taskId, action);
  const text = outcome.ok
    ? action === "done"
      ? outcome.task?.recurrenceNextTaskId
        ? "Đã hoàn thành và tạo công việc cho kỳ tiếp theo."
        : "Đã hoàn thành công việc."
      : "Đã hoãn công việc."
    : outcome.reason === "no_workday"
      ? "Không tìm thấy ngày làm việc kế tiếp trong lịch cài đặt."
      : "Công việc không còn khả dụng.";
  await telegramRequest(token, "answerCallbackQuery", { callback_query_id: callback.id, text });
  if (outcome.ok) {
    await telegramRequest(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
    await logNotification(database, uid, {
      type: `telegram_action_${action}`,
      status: "success",
      taskId,
      taskTitle: outcome.task?.title || callback.message?.text?.slice(0, 100) || "Công việc",
      message: text
    });
  }
}

module.exports = async function telegramWebhook(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed." });
  }
  if (!hasSecret(request)) return response.status(401).json({ error: "Unauthorized." });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return response.status(500).json({ error: "Telegram bot token is missing." });
  try {
    const { database } = getFirebaseServices();
    const message = request.body?.message;
    if (message?.chat?.type === "private" && typeof message.text === "string") {
      const start = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]+))?/.exec(message.text);
      if (start) {
        const reply = start[1]
          ? await linkChat(database, message.chat.id, start[1])
          : "Để liên kết, hãy tạo liên kết Telegram trong Cài đặt của Task Manager rồi nhấn Start.";
        await sendReply(token, message.chat.id, reply);
      } else if (/^\/unlink(?:@\w+)?(?:\s|$)/.test(message.text)) {
        await sendReply(token, message.chat.id, await unlinkChat(database, message.chat.id));
      } else if (/^\/help(?:@\w+)?(?:\s|$)/.test(message.text)) {
        await sendReply(token, message.chat.id, "Dùng /start để liên kết từ Task Manager hoặc /unlink để ngắt liên kết.");
      }
    }
    if (request.body?.callback_query) {
      await handleCallback(database, token, request.body.callback_query);
    }
    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook failed:", error);
    return response.status(500).json({ error: "Telegram webhook failed." });
  }
};
