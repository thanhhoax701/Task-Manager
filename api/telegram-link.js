const { createHash, randomBytes } = require("node:crypto");
const { getFirebaseServices } = require("./firebase-admin");

const CODE_TTL_MS = 10 * 60_000;

function hashCode(code) {
  return createHash("sha256").update(code).digest("hex");
}

function isChatId(value) {
  return /^-?\d+$/.test(String(value ?? ""));
}

module.exports = async function telegramLink(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed." });
  }
  const authorization = request.headers.authorization;
  const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!token) return response.status(401).json({ error: "Unauthorized." });

  try {
    const { auth, database } = getFirebaseServices();
    const decoded = await auth.verifyIdToken(token);
    const uid = decoded.uid;
    const settingsRef = database.ref(`users/${uid}/settings`);
    const settings = (await settingsRef.get()).val() || {};
    const previousHash = settings.telegramPendingLinkHash;
    const action = request.body?.action || "create";

    if (action === "unlink") {
      const chatId = settings.telegramChatId;
      if (isChatId(chatId)) {
        const ownerRef = database.ref(`telegramChatOwners/${chatId}`);
        const ownership = await ownerRef.transaction(current => current === uid ? null : current);
        if (ownership.snapshot.val() && ownership.snapshot.val() !== uid) {
          throw new Error("Telegram chat ownership did not match this account.");
        }
      }
      const updates = {
        [`users/${uid}/settings/telegramChatId`]: null,
        [`users/${uid}/settings/telegramLinkedAt`]: null,
        [`users/${uid}/settings/telegramPendingLinkHash`]: null,
        [`users/${uid}/settings/telegramPendingLinkExpiresAt`]: null
      };
      if (/^[a-f0-9]{64}$/.test(previousHash || "")) {
        updates[`telegramLinkCodes/${previousHash}`] = null;
      }
      await database.ref().update(updates);
      return response.status(200).json({ ok: true, linked: false });
    }

    if (action !== "create") {
      return response.status(400).json({ error: "Unsupported action." });
    }

    const code = randomBytes(18).toString("base64url");
    const codeHash = hashCode(code);
    const expiresAt = Date.now() + CODE_TTL_MS;
    const updates = {
      [`telegramLinkCodes/${codeHash}`]: { uid, expiresAt },
      [`users/${uid}/settings/telegramPendingLinkHash`]: codeHash,
      [`users/${uid}/settings/telegramPendingLinkExpiresAt`]: expiresAt
    };
    if (/^[a-f0-9]{64}$/.test(previousHash || "")) {
      updates[`telegramLinkCodes/${previousHash}`] = null;
    }
    await database.ref().update(updates);
    return response.status(200).json({ code, expiresAt });
  } catch (error) {
    if (error.code === "auth/argument-error" || error.code === "auth/id-token-expired" ||
        error.code === "auth/invalid-id-token" || error.code === "auth/id-token-revoked") {
      return response.status(401).json({ error: "Unauthorized." });
    }
    console.error("Telegram account linking failed:", error);
    return response.status(500).json({ error: "Could not link Telegram account." });
  }
};
