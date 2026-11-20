const { getFirebaseServices } = require("./firebase-admin");

function bearerToken(request) {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
}

function validKey(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(String(value || ""));
}

function fail(response, status, message) {
  return response.status(status).json({ error: message });
}

module.exports = async function taskCollaboration(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return fail(response, 405, "Method not allowed.");
  }
  const token = bearerToken(request);
  if (!token) return fail(response, 401, "Unauthorized.");

  try {
    const { auth, database, firestore } = getFirebaseServices();
    const decoded = await auth.verifyIdToken(token, true);
    const { action } = request.body || {};
    const taskId = String(request.body?.taskId || "");
    const requestedOwnerUid = String(request.body?.ownerUid || "");
    if (!validKey(taskId) || !validKey(requestedOwnerUid)) {
      return fail(response, 400, "Công việc không hợp lệ.");
    }

    const membersRef = database.ref(`taskMembers/${taskId}`);
    const membersSnapshot = await membersRef.get();
    const collaboration = membersSnapshot.val() || {};
    if (collaboration.ownerUid && collaboration.ownerUid !== requestedOwnerUid) {
      return fail(response, 409, "Thông tin chủ sở hữu công việc không khớp.");
    }
    const isOwner = decoded.uid === requestedOwnerUid;
    const isMember = Boolean(collaboration.members?.[decoded.uid]);
    const isAdmin = decoded.role === "admin";
    if ((action === "addMember" || action === "removeMember") && !isOwner && !isAdmin) {
      return fail(response, 403, "Chỉ chủ công việc hoặc Admin được quản lý thành viên.");
    }
    if (!isOwner && !isMember && !isAdmin && action !== "addMember") {
      return fail(response, 403, "Bạn chưa được giao công việc này.");
    }

    const taskRef = database.ref(`users/${requestedOwnerUid}/tasks/${taskId}`);
    const taskSnapshot = await taskRef.get();
    const task = taskSnapshot.val();
    if (!task || (task.deletedAt && requestedOwnerUid !== decoded.uid)) {
      return fail(response, 404, "Không tìm thấy công việc.");
    }

    if (action === "addMember" || action === "removeMember") {
      if (!isOwner && !isAdmin) return fail(response, 403, "Chỉ chủ công việc hoặc Admin được quản lý thành viên.");
      if (action === "addMember") {
        const email = String(request.body?.email || "").trim().toLowerCase();
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return fail(response, 400, "Email không hợp lệ.");
        }
        let invited;
        try {
          invited = await auth.getUserByEmail(email);
        } catch (error) {
          if (error.code === "auth/user-not-found") return fail(response, 404, "Người dùng cần đăng ký tài khoản trước khi được giao việc.");
          throw error;
        }
        if (invited.uid === requestedOwnerUid) return fail(response, 400, "Chủ công việc không thể được giao lại công việc của mình.");
        const profile = (await firestore.collection("users").doc(invited.uid).get()).data() || {};
        const member = {
          uid: invited.uid,
          email: invited.email || email,
          displayName: profile.displayName || invited.displayName || email,
          assignedAt: Date.now(),
          progressPercent: Number(collaboration.members?.[invited.uid]?.progressPercent) || 0
        };
        const updates = {
          [`taskMembers/${taskId}/ownerUid`]: requestedOwnerUid,
          [`taskMembers/${taskId}/members/${invited.uid}`]: member,
          [`taskMemberships/${invited.uid}/${taskId}`]: {
            ownerUid: requestedOwnerUid,
            taskId,
            assignedAt: member.assignedAt,
            progressPercent: member.progressPercent
          }
        };
        await database.ref().update(updates);
        return response.status(200).json({ ok: true, member });
      }

      const memberUid = String(request.body?.memberUid || "");
      if (!validKey(memberUid)) return fail(response, 400, "Thành viên không hợp lệ.");
      if (!collaboration.members?.[memberUid]) return fail(response, 404, "Không tìm thấy thành viên.");
      await database.ref().update({
        [`taskMembers/${taskId}/members/${memberUid}`]: null,
        [`taskMemberships/${memberUid}/${taskId}`]: null,
        [`taskProgress/${taskId}/${memberUid}`]: null
      });
      return response.status(200).json({ ok: true });
    }

    if (action === "progress") {
      if (!isMember) return fail(response, 403, "Chỉ người được giao việc mới cập nhật tiến độ cá nhân.");
      const percent = Number(request.body?.percent);
      const note = String(request.body?.note || "").trim();
      if (!Number.isInteger(percent) || percent < 0 || percent > 100 || note.length > 250) {
        return fail(response, 400, "Tiến độ hoặc ghi chú không hợp lệ.");
      }
      const now = Date.now();
      await database.ref().update({
        [`taskProgress/${taskId}/${decoded.uid}`]: {
          percent,
          note,
          updatedAt: now
        },
        [`taskMembers/${taskId}/members/${decoded.uid}/progressPercent`]: percent,
        [`taskMembers/${taskId}/members/${decoded.uid}/progressUpdatedAt`]: now,
        [`taskMemberships/${decoded.uid}/${taskId}/progressPercent`]: percent,
        [`taskMemberships/${decoded.uid}/${taskId}/progressUpdatedAt`]: now
      });
      return response.status(200).json({ ok: true, percent, updatedAt: now });
    }

    if (action === "comment") {
      const text = String(request.body?.text || "").trim();
      if (!text || text.length > 2000) return fail(response, 400, "Bình luận phải có từ 1 đến 2000 ký tự.");
      const profile = (await firestore.collection("users").doc(decoded.uid).get()).data() || {};
      const commentRef = database.ref(`taskComments/${taskId}`).push();
      const comment = {
        uid: decoded.uid,
        displayName: profile.displayName || decoded.name || decoded.email || "Người dùng",
        text,
        createdAt: Date.now()
      };
      await commentRef.set(comment);
      return response.status(200).json({ ok: true, id: commentRef.key, comment });
    }

    if (action === "list") {
      const [commentsSnapshot, progressSnapshot] = await Promise.all([
        database.ref(`taskComments/${taskId}`).orderByChild("createdAt").limitToLast(100).get(),
        database.ref(`taskProgress/${taskId}`).get()
      ]);
      const comments = Object.entries(commentsSnapshot.val() || {})
        .map(([id, comment]) => ({ id, ...comment }))
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      return response.status(200).json({
        ownerUid: requestedOwnerUid,
        members: Object.values(collaboration.members || {}),
        comments,
        progress: progressSnapshot.val() || {},
        viewerProgress: collaboration.members?.[decoded.uid]
          ? progressSnapshot.child(decoded.uid).val() || null
          : null
      });
    }

    return fail(response, 400, "Thao tác không hợp lệ.");
  } catch (error) {
    if (["auth/argument-error", "auth/id-token-expired", "auth/invalid-id-token",
      "auth/id-token-revoked"].includes(error.code)) {
      return fail(response, 401, "Unauthorized.");
    }
    console.error("Task collaboration failed:", error);
    return fail(response, 500, "Không thể xử lý cộng tác công việc.");
  }
};
