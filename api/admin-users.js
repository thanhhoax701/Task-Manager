const { getFirebaseServices } = require("./firebase-admin");

function bearerToken(request) {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
}

function adminEmails() {
  return new Set((process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean));
}

function invalidRequest(response, message) {
  return response.status(400).json({ error: message });
}

module.exports = async function adminUsers(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed." });
  }
  const token = bearerToken(request);
  if (!token) return response.status(401).json({ error: "Unauthorized." });

  try {
    const { auth, firestore } = getFirebaseServices();
    const decoded = await auth.verifyIdToken(token, true);
    if (decoded.role !== "admin") return response.status(403).json({ error: "Admin role required." });
    const action = request.body?.action;

    if (action === "lookup") {
      const email = String(request.body?.email || "").trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return invalidRequest(response, "Email không hợp lệ.");
      }
      let user;
      try {
        user = await auth.getUserByEmail(email);
      } catch (error) {
        if (error.code === "auth/user-not-found") return response.status(404).json({ error: "Không tìm thấy tài khoản." });
        throw error;
      }
      const profile = (await firestore.collection("users").doc(user.uid).get()).data() || {};
      return response.status(200).json({
        uid: user.uid,
        email: user.email,
        displayName: profile.displayName || user.displayName || "",
        role: user.customClaims?.role === "admin" ? "admin" : "user"
      });
    }

    if (action !== "setRole") return invalidRequest(response, "Thao tác không hợp lệ.");
    const uid = String(request.body?.uid || "");
    const role = request.body?.role;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !["admin", "user"].includes(role)) {
      return invalidRequest(response, "Tài khoản hoặc vai trò không hợp lệ.");
    }

    const target = await auth.getUser(uid);
    const currentRole = target.customClaims?.role === "admin" ? "admin" : "user";
    if (currentRole === role) return response.status(200).json({ ok: true, uid, role });
    if (uid === decoded.uid) {
      return response.status(400).json({ error: "Hãy dùng một tài khoản Admin khác để đổi vai trò của chính bạn." });
    }
    const protectedAdmin = adminEmails().has(String(target.email || "").toLowerCase());
    if (protectedAdmin && role !== "admin") {
      return response.status(403).json({ error: "Không thể gỡ quyền của email khởi tạo Admin." });
    }
    const customClaims = { ...target.customClaims };
    if (role === "admin") customClaims.role = "admin";
    else delete customClaims.role;
    await auth.setCustomUserClaims(uid, customClaims);
    await auth.revokeRefreshTokens(uid);
    return response.status(200).json({ ok: true, uid, role });
  } catch (error) {
    if (["auth/argument-error", "auth/id-token-expired", "auth/invalid-id-token",
      "auth/id-token-revoked"].includes(error.code)) {
      return response.status(401).json({ error: "Unauthorized." });
    }
    console.error("Admin user management failed:", error);
    return response.status(500).json({ error: "Could not update user role." });
  }
};
