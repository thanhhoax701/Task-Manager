import {
  get as getRealtimeValue, onValue, ref, set, update, remove, push, serverTimestamp,
  query, orderByChild, limitToLast, runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import {
  collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  deleteObject, getDownloadURL, ref as storageRef, uploadBytes
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { db, realtimeDb, storage } from "./firebase.js";
import { buildNextOccurrence } from "./recurrence-utils.mjs";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "text/plain", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);

function tasksRef(uid) {
  return ref(realtimeDb, `users/${uid}/tasks`);
}

function taskRef(uid, taskId) {
  return ref(realtimeDb, `users/${uid}/tasks/${taskId}`);
}

function groupsRef(uid) {
  return ref(realtimeDb, `users/${uid}/groups`);
}

function groupRef(uid, groupId) {
  return ref(realtimeDb, `users/${uid}/groups/${groupId}`);
}

function settingsRef(uid) {
  return ref(realtimeDb, `users/${uid}/settings`);
}

function activitiesRef(uid) {
  return ref(realtimeDb, `users/${uid}/activities`);
}

function serializeValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, serializeValue(item)])
    );
  }
  return value;
}

function serializeTask(task) {
  const serialized = {};
  for (const [key, value] of Object.entries(task)) {
    if (value === undefined) continue;
    if (["checklist", "subtasks", "tags", "attachments"].includes(key)) {
      const items = Array.isArray(value) ? value : Object.values(value || {});
      serialized[key] = items.length
        ? Object.fromEntries(items.map((item, index) => [
          item.id || String(index),
          serializeValue(item)
        ]))
        : null;
    } else {
      serialized[key] = serializeValue(value);
    }
  }
  return serialized;
}

function deserializeItems(value) {
  if (!value) return [];
  const items = Array.isArray(value)
    ? value
    : Object.entries(value).map(([id, item]) => item && typeof item === "object"
      ? { id, ...item }
      : { id, name: String(item), title: String(item) });
  return items.filter(Boolean).map(item => typeof item === "string"
    ? { id: item, name: item, title: item }
    : item);
}

function deserializeTask(task) {
  return {
    ...task,
    checklist: deserializeItems(task.checklist),
    subtasks: deserializeItems(task.subtasks),
    tags: deserializeItems(task.tags),
    attachments: deserializeItems(task.attachments)
  };
}

export function subscribeTasks(uid, callback, onError) {
  return onValue(tasksRef(uid), snapshot => {
    const stored = snapshot.val() || {};
    const tasks = Object.entries(stored)
      .map(([id, task]) => ({ ...deserializeTask(task), id, ownerUid: uid, sharedReadOnly: false }))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    callback(tasks);
  }, onError);
}

export function subscribeAssignedTasks(uid, callback, onError) {
  const taskSubscriptions = new Map();
  const assignedTasks = new Map();
  let memberships = {};
  const membershipRef = ref(realtimeDb, `taskMemberships/${uid}`);
  const unsubscribeMemberships = onValue(membershipRef, snapshot => {
    memberships = snapshot.val() || {};
    const activeKeys = new Set(Object.entries(memberships)
      .map(([taskId, membership]) => `${membership?.ownerUid || ""}:${taskId}`));

    for (const [key, unsubscribe] of taskSubscriptions) {
      if (activeKeys.has(key)) continue;
      unsubscribe();
      taskSubscriptions.delete(key);
      assignedTasks.delete(key);
    }

    for (const [taskId, membership] of Object.entries(memberships)) {
      const ownerUid = membership?.ownerUid;
      if (!ownerUid || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) continue;
      const key = `${ownerUid}:${taskId}`;
      const currentTask = assignedTasks.get(key);
      if (currentTask) {
        currentTask.memberProgressPercent = Number(membership.progressPercent) || 0;
        assignedTasks.set(key, currentTask);
      }
      if (taskSubscriptions.has(key)) continue;
      const unsubscribe = onValue(taskRef(ownerUid, taskId), taskSnapshot => {
        const value = taskSnapshot.val();
        if (!value || value.deletedAt) {
          assignedTasks.delete(key);
        } else {
          assignedTasks.set(key, {
            ...deserializeTask(value),
            id: taskId,
            ownerUid,
            sharedReadOnly: true,
            memberProgressPercent: Number(memberships[taskId]?.progressPercent) || 0
          });
        }
        callback([...assignedTasks.values()]);
      }, onError);
      taskSubscriptions.set(key, unsubscribe);
    }
    callback([...assignedTasks.values()]);
  }, onError);

  return () => {
    unsubscribeMemberships();
    taskSubscriptions.forEach(unsubscribe => unsubscribe());
    taskSubscriptions.clear();
    assignedTasks.clear();
  };
}

export function subscribeGroups(uid, callback, onError) {
  return onValue(groupsRef(uid), snapshot => {
    const stored = snapshot.val() || {};
    const groups = Object.entries(stored)
      .map(([id, group]) => ({ id, ...group }))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "vi"));
    callback(groups);
  }, onError);
}

export async function saveGroup(uid, name, groupId = null) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) throw new Error("Tên nhóm không được để trống.");
  if (normalizedName.length > 40) throw new Error("Tên nhóm không được dài quá 40 ký tự.");

  const data = { name: normalizedName, updatedAt: serverTimestamp() };
  if (groupId) {
    await update(groupRef(uid, groupId), data);
    return;
  }

  const newGroupRef = push(groupsRef(uid));
  await set(newGroupRef, { ...data, createdAt: serverTimestamp() });
}

export async function deleteGroup(uid, groupId, tasks) {
  const updates = { [`groups/${groupId}`]: null };
  const deletedAt = serverTimestamp();

  for (const task of tasks) {
    if (task.groupId !== groupId) continue;
    updates[`tasks/${task.id}/groupId`] = null;
    if (!task.deletedAt) {
      updates[`tasks/${task.id}/deletedAt`] = deletedAt;
      updates[`tasks/${task.id}/updatedAt`] = deletedAt;
    }
  }

  await update(ref(realtimeDb, `users/${uid}`), updates);
}

export function subscribeSettings(uid, callback, onError) {
  return onValue(settingsRef(uid), snapshot => callback(snapshot.val() || {}), onError);
}

export async function saveSettings(uid, settings) {
  const { daysOff, holidays, ...preferences } = settings;
  await update(settingsRef(uid), {
    ...preferences,
    daysOff: daysOff.join(","),
    holidays: holidays.join(","),
    updatedAt: serverTimestamp()
  });
}

export function subscribeActivities(uid, callback, onError) {
  const recentActivities = query(activitiesRef(uid), limitToLast(100));
  return onValue(recentActivities, snapshot => {
    const stored = snapshot.val() || {};
    const activities = Object.entries(stored)
      .map(([id, activity]) => ({ id, ...activity }))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    callback(activities);
  }, onError);
}

export function subscribeNotificationLogs(uid, callback, onError) {
  const recentLogs = query(
    ref(realtimeDb, `users/${uid}/notificationLogs`),
    orderByChild("createdAt"),
    limitToLast(100)
  );
  return onValue(recentLogs, snapshot => {
    const stored = snapshot.val() || {};
    const logs = Object.entries(stored)
      .map(([id, log]) => ({ id, ...log }))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    callback(logs);
  }, onError);
}

export async function addActivity(uid, message) {
  const activityRef = push(activitiesRef(uid));
  await set(activityRef, {
    message: String(message).slice(0, 180),
    createdAt: serverTimestamp()
  });

  const recentActivities = query(activitiesRef(uid), limitToLast(101));
  const snapshot = await getRealtimeValue(recentActivities);
  const oldest = Object.entries(snapshot.val() || {})
    .map(([id, activity]) => ({ id, createdAt: Number(activity.createdAt || 0) }))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (oldest.length > 100) {
    await Promise.all(oldest.slice(0, oldest.length - 100).map(item =>
      remove(ref(realtimeDb, `users/${uid}/activities/${item.id}`))
    ));
  }
}

export async function ensureTasksMigrated(uid) {
  const migrationRef = ref(realtimeDb, `users/${uid}/migrations/firestoreTasksV1`);
  const migrationSnapshot = await getRealtimeValue(migrationRef);
  if (migrationSnapshot.exists()) return { migrated: false, copied: 0 };

  const firestoreSnapshot = await getDocs(collection(db, "users", uid, "tasks"));
  const legacyTasks = Object.fromEntries(firestoreSnapshot.docs.map(taskSnapshot => [
    taskSnapshot.id,
    serializeTask(taskSnapshot.data())
  ]));
  let copied = 0;
  const migration = await runTransaction(tasksRef(uid), current => {
    const existing = current || {};
    const missing = Object.fromEntries(Object.entries(legacyTasks).filter(([id]) =>
      !Object.prototype.hasOwnProperty.call(existing, id)
    ));
    copied = Object.keys(missing).length;
    return copied ? { ...existing, ...missing } : undefined;
  });
  if (!migration.committed) copied = 0;
  await set(migrationRef, {
    completedAt: serverTimestamp(),
    copiedCount: copied
  });
  return { migrated: true, copied };
}

export async function saveTask(uid, data, taskId = null) {
  const payload = {
    ...data,
    startAt: data.startAt || null,
    dueAt: data.dueAt || null,
    remindBeforeMinutes: data.dueAt && [5, 15, 30, 60].includes(Number(data.remindBeforeMinutes))
      ? Number(data.remindBeforeMinutes)
      : 0,
    recurrence: ["daily", "weekly", "monthly", "yearly"].includes(data.recurrence)
      ? data.recurrence
      : "none",
    recurrenceAnchorDay: ["monthly", "yearly"].includes(data.recurrence) && data.dueAt
      ? Number(data.recurrenceAnchorDay) || new Date(data.dueAt).getDate()
      : null,
    recurrenceAnchorMonth: data.recurrence === "yearly" && data.dueAt
      ? data.recurrenceAnchorMonth != null && Number.isInteger(Number(data.recurrenceAnchorMonth))
        ? Number(data.recurrenceAnchorMonth)
        : new Date(data.dueAt).getMonth()
      : null,
    groupId: data.groupId || null,
    checklist: Array.isArray(data.checklist) ? data.checklist : [],
    subtasks: Array.isArray(data.subtasks) ? data.subtasks : [],
    tags: Array.isArray(data.tags) ? data.tags : [],
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
    color: typeof data.color === "string" && /^#[0-9a-f]{6}$/i.test(data.color)
      ? data.color
      : "#ffffff",
    favorite: Boolean(data.favorite),
    completedAt: data.status === "completed" ? data.completedAt || Date.now() : null,
    deletedAt: data.deletedAt || null,
    updatedAt: serverTimestamp()
  };

  if (taskId) {
    await update(taskRef(uid, taskId), serializeTask(payload));
    return taskId;
  }

  const newTaskRef = push(tasksRef(uid));
  await set(newTaskRef, serializeTask({
    ...payload,
    createdAt: serverTimestamp(),
    status: data.status || "pending",
    reminderSentAt: null,
    preReminderSentAt: null
  }));
  return newTaskRef.key;
}

export async function setTaskStatus(uid, taskId, status) {
  const completed = status === "completed";
  const result = await runTransaction(taskRef(uid, taskId), current => {
    if (!current) return;
    const task = deserializeTask(current);
    return serializeTask({
      ...current,
      status,
      checklist: task.checklist.map(item => ({ ...item, completed })),
      subtasks: task.subtasks.map(item => ({ ...item, status: completed ? "completed" : "pending" })),
      completedAt: completed ? current.completedAt || Date.now() : null,
      updatedAt: Date.now()
    });
  });
  if (!result.snapshot.exists()) throw new Error("Không tìm thấy công việc.");
  if (completed) await ensureNextOccurrence(uid, taskId);
}

async function ensureNextOccurrence(uid, taskId) {
  const proposedNextTaskId = push(tasksRef(uid)).key;
  const result = await runTransaction(taskRef(uid, taskId), current => {
    if (!current || current.status !== "completed" ||
        !["daily", "weekly", "monthly", "yearly"].includes(current.recurrence) ||
        !current.dueAt) return;
    if (current.recurrenceNextTaskId) return current;
    const recurrenceCount = Number(current.recurrenceCount || 0) + 1;
    return {
      ...current,
      recurrenceCount,
      recurrenceNextTaskId: proposedNextTaskId
    };
  });
  const source = result.snapshot.val();
  const nextTaskId = source?.recurrenceNextTaskId;
  if (!result.committed || !nextTaskId) return;
  const builtNextTask = buildNextOccurrence(
    deserializeTask(source),
    nextTaskId,
    Date.now()
  );
  if (!builtNextTask) return;
  const { id, ...nextTask } = builtNextTask;
  await runTransaction(taskRef(uid, nextTaskId), current =>
    current || serializeTask(nextTask)
  );
}

export async function removeTask(uid, taskId) {
  await update(taskRef(uid, taskId), {
    deletedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function restoreTask(uid, taskId) {
  await update(taskRef(uid, taskId), {
    deletedAt: null,
    updatedAt: serverTimestamp()
  });
}

export async function uploadTaskAttachment(uid, taskId, file) {
  validateTaskAttachment(file);

  const id = crypto.randomUUID();
  const safeFileName = file.name.replace(/[^\w.-]/g, "_").slice(0, 100) || "attachment";
  const path = `users/${uid}/tasks/${taskId}/attachments/${id}_${safeFileName}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type });
  let url;
  try {
    url = await getDownloadURL(fileRef);
  } catch (error) {
    try {
      await deleteObject(fileRef);
    } catch (cleanupError) {
      throw new Error(`Không lấy được liên kết tải tệp "${file.name}"; dọn tệp thất bại: ${cleanupError.message}`);
    }
    throw error;
  }
  return {
    id,
    name: file.name,
    url,
    path,
    kind: "file",
    contentType: file.type,
    size: file.size,
    createdAt: Date.now()
  };
}

export function validateTaskAttachment(file) {
  if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
    throw new Error(`Định dạng tệp "${file.name}" chưa được hỗ trợ.`);
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`Tệp "${file.name}" vượt quá giới hạn 10 MB.`);
  }
}

export async function deleteTaskAttachments(uid, taskId, attachments) {
  const failures = [];
  const pathPrefix = `users/${uid}/tasks/${taskId}/attachments/`;
  for (const attachment of attachments) {
    if (!attachment.path) continue;
    if (!attachment.path.startsWith(pathPrefix)) {
      failures.push({ attachment, name: attachment.name, error: new Error("Đường dẫn tệp không hợp lệ.") });
      continue;
    }
    try {
      await deleteObject(storageRef(storage, attachment.path));
    } catch (error) {
      if (error.code !== "storage/object-not-found") failures.push({ attachment, name: attachment.name, error });
    }
  }
  return failures;
}

export async function permanentlyDeleteTask(uid, taskId) {
  const snapshot = await getRealtimeValue(taskRef(uid, taskId));
  if (!snapshot.exists()) return [];
  const attachments = deserializeTask(snapshot.val()).attachments;
  const failures = await deleteTaskAttachments(uid, taskId, attachments);
  if (failures.length) return failures;
  await remove(taskRef(uid, taskId));
  return [];
}

export async function setTaskFavorite(uid, taskId, favorite) {
  await update(taskRef(uid, taskId), {
    favorite,
    updatedAt: serverTimestamp()
  });
}

export async function saveTaskItems(uid, task, checklist, subtasks) {
  const hasItems = checklist.length + subtasks.length > 0;
  const allComplete = hasItems &&
    checklist.every(item => item.completed) &&
    subtasks.every(item => item.status === "completed");
  const anyIncomplete = checklist.some(item => !item.completed) ||
    subtasks.some(item => item.status !== "completed");
  const status = allComplete ? "completed" :
    (task.status === "completed" && anyIncomplete ? "pending" : task.status || "pending");

  await update(taskRef(uid, task.id), serializeTask({
    checklist,
    subtasks,
    status,
    completedAt: status === "completed" ? task.completedAt || Date.now() : null,
    updatedAt: serverTimestamp()
  }));
  if (status === "completed") await ensureNextOccurrence(uid, task.id);
}

export function duplicateTaskDraft(task) {
  const {
    id, ownerUid, sharedReadOnly, memberProgressPercent,
    createdAt, updatedAt, deletedAt, ...copy
  } = task;
  return {
    ...copy,
    title: String(task.title || "Công việc"),
    status: "pending",
    favorite: false,
    deletedAt: null,
    completedAt: null,
    reminderAt: null,
    reminderSentAt: null,
    preReminderSentAt: null,
    notificationClaimedAt: null,
    recurrenceCount: 0,
    recurrenceNextTaskId: null,
    checklist: (task.checklist || []).map(item => ({ ...item, completed: false })),
    subtasks: (task.subtasks || []).map(item => ({ ...item, status: "pending" })),
    tags: (task.tags || []).map(tag => ({ ...tag })),
    attachments: (task.attachments || []).filter(attachment => attachment.kind === "link")
  };
}
