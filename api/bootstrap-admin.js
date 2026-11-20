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

module.exports = async function bootstrapAdmin(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed." });
  }
  const token = bearerToken(request);
  if (!token) return response.status(401).json({ error: "Unauthorized." });

  try {
    const { auth } = getFirebaseServices();
    const decoded = await auth.verifyIdToken(token, true);
    const allowlisted = adminEmails().has(String(decoded.email || "").toLowerCase());
    if (!allowlisted) {
      return response.status(200).json({ role: decoded.role === "admin" ? "admin" : "user" });
    }

    const user = await auth.getUser(decoded.uid);
    if (!user.emailVerified) {
      return response.status(403).json({ error: "Hãy xác minh email trước khi nhận quyền Admin." });
    }
    if (user.customClaims?.role !== "admin") {
      await auth.setCustomUserClaims(user.uid, { ...user.customClaims, role: "admin" });
      return response.status(200).json({ role: "admin", claimsUpdated: true });
    }
    return response.status(200).json({ role: "admin", claimsUpdated: false });
  } catch (error) {
    if (["auth/argument-error", "auth/id-token-expired", "auth/invalid-id-token",
      "auth/id-token-revoked"].includes(error.code)) {
      return response.status(401).json({ error: "Unauthorized." });
    }
    console.error("Admin role bootstrap failed:", error);
    return response.status(500).json({ error: "Could not load account role." });
  }
};
