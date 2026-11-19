import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/v2";
import { randomBytes, timingSafeEqual } from "node:crypto";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "asia-southeast1", maxInstances: 10 });

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_WEBHOOK_SECRET = defineSecret("TELEGRAM_WEBHOOK_SECRET");
const BOT_USERNAME = "YOUR_TELEGRAM_BOT_USERNAME";

async function telegramRequest(token: string, method: string, body: object) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API error: ${result.description || response.statusText}`);
  }
  return result;
}

// Frontend gọi function này sau khi người dùng đăng nhập Firebase.
export const createTelegramLinkCode = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Bạn cần đăng nhập.");
  const uid = request.auth.uid;
  const code = randomBytes(18).toString("hex");
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));

  await db.collection("telegramLinkCodes").doc(code).set({
    uid, createdAt: FieldValue.serverTimestamp(), expiresAt
  });

  return {
    deepLink: `https://t.me/${BOT_USERNAME}?start=${code}`,
    expiresInMinutes: 10
  };
});

// Telegram webhook: nhận /start <code>, gắn chatId vào đúng UID.
export const telegramWebhook = onRequest(
  { secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

    const supplied = req.header("X-Telegram-Bot-Api-Secret-Token") || "";
    const expected = TELEGRAM_WEBHOOK_SECRET.value();
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).send("Unauthorized"); return;
    }

    const message = req.body?.message;
    const chatId = message?.chat?.id;
    const text = String(message?.text || "");
    const match = text.match(/^\/start\s+([a-f0-9]{36})$/i);

    try {
      if (chatId && match) {
        const code = match[1];
        const codeRef = db.collection("telegramLinkCodes").doc(code);
        await db.runTransaction(async tx => {
          const snap = await tx.get(codeRef);
          if (!snap.exists) throw new Error("Mã liên kết không hợp lệ hoặc đã sử dụng.");
          const data = snap.data()!;
          if (data.expiresAt.toMillis() < Date.now()) {
            tx.delete(codeRef);
            throw new Error("Mã liên kết đã hết hạn. Hãy tạo mã mới trong ứng dụng.");
          }
          const userRef = db.doc(`users/${data.uid}/private/telegram`);
          tx.set(userRef, {
            chatId: String(chatId),
            linkedAt: FieldValue.serverTimestamp(),
            username: message.from?.username || null,
            firstName: message.from?.first_name || null
          });
          tx.delete(codeRef);
        });
        await telegramRequest(TELEGRAM_BOT_TOKEN.value(), "sendMessage", {
          chat_id: chatId,
          text: "✅ Liên kết Task Manager thành công! Từ bây giờ bot sẽ gửi nhắc việc đến tài khoản này."
        });
      } else if (chatId) {
        await telegramRequest(TELEGRAM_BOT_TOKEN.value(), "sendMessage", {
          chat_id: chatId,
          text: "Xin chào! Để liên kết, hãy mở chức năng Liên kết Telegram trong Task Manager và nhấn nút mở bot."
        });
      }
      res.status(200).send("OK");
    } catch (error) {
      console.error("Telegram webhook error", error);
      if (chatId) {
        try {
          await telegramRequest(TELEGRAM_BOT_TOKEN.value(), "sendMessage", {
            chat_id: chatId,
            text: error instanceof Error ? error.message : "Không thể liên kết tài khoản."
          });
        } catch (sendError) { console.error(sendError); }
      }
      // Trả 200 để Telegram không retry một update đã xử lý lỗi nghiệp vụ.
      res.status(200).send("OK");
    }
  }
);

// Scheduler chạy mỗi phút. Mỗi task chỉ được gửi một lần cho một lần đặt nhắc.
export const sendDueTaskReminders = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Asia/Ho_Chi_Minh", secrets: [TELEGRAM_BOT_TOKEN] },
  async () => {
    const now = Timestamp.now();
    const dueSnap = await db.collectionGroup("tasks")
      .where("reminderSentAt", "==", null)
      .where("reminderAt", "<=", now)
      .limit(200)
      .get();

    for (const taskDoc of dueSnap.docs) {
      const task = taskDoc.data();
      const parts = taskDoc.ref.path.split("/");
      const uid = parts[1];
      const userRef = db.doc(`users/${uid}/private/telegram`);
      const telegramSnap = await userRef.get();

      // Đánh dấu đã xử lý để tránh lặp liên tục; nếu chưa liên kết thì người dùng cần tạo lại nhắc sau khi liên kết.
      if (task.status === "completed" || !telegramSnap.exists || !telegramSnap.data()?.chatId) {
        await taskDoc.ref.update({ reminderSentAt: FieldValue.serverTimestamp(), reminderResult: "skipped" });
        continue;
      }

      const chatId = telegramSnap.data()!.chatId;
      const due = task.reminderAt?.toDate?.() as Date | undefined;
      const dueText = due ? new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh"
      }).format(due) : "Đến hạn";

      const message = [
        "🔔 NHẮC VIỆC",
        "",
        `📌 ${task.title || "Công việc"}`,
        task.description ? `📝 ${task.description}` : "",
        `📂 Danh mục: ${task.category || "Khác"}`,
        `⚡ Ưu tiên: ${{ high: "Cao", medium: "Trung bình", low: "Thấp" }[task.priority as string] || "Trung bình"}`,
        `🕒 Thời hạn: ${dueText}`,
        "",
        "Mở Task Manager để cập nhật trạng thái."
      ].filter(Boolean).join("\n");

      try {
        await telegramRequest(TELEGRAM_BOT_TOKEN.value(), "sendMessage", {
          chat_id: chatId, text: message
        });
        await taskDoc.ref.update({ reminderSentAt: FieldValue.serverTimestamp(), reminderResult: "sent" });
      } catch (error) {
        console.error(`Cannot send reminder for ${taskDoc.ref.path}`, error);
        // Đánh dấu lỗi để tránh gửi lặp mỗi phút; quản trị viên có thể kiểm tra log.
        await taskDoc.ref.update({ reminderSentAt: FieldValue.serverTimestamp(), reminderResult: "error" });
      }
    }
  }
);
