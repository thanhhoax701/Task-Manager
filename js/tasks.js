import {
  get as getRealtimeValue, onValue, ref, set, update, remove, push, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import {
  collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db, realtimeDb } from "./firebase.js";

function tasksRef(uid) {
  return ref(realtimeDb, `users/${uid}/tasks`);
}

function taskRef(uid, taskId) {
  return ref(realtimeDb, `users/${uid}/tasks/${taskId}`);
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
    if (key === "checklist" || key === "subtasks") {
      serialized[key] = value.length
        ? Object.fromEntries(value.map((item, index) => [
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
    : Object.entries(value).map(([id, item]) => ({ id, ...item }));
  return items.filter(Boolean);
}

function deserializeTask(task) {
  return {
    ...task,
    checklist: deserializeItems(task.checklist),
    subtasks: deserializeItems(task.subtasks)
  };
}

export function subscribeTasks(uid, callback, onError) {
  return onValue(tasksRef(uid), snapshot => {
    const stored = snapshot.val() || {};
    const tasks = Object.entries(stored)
      .map(([id, task]) => ({ id, ...deserializeTask(task) }))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    callback(tasks);
  }, onError);
}

export async function ensureTasksMigrated(uid) {
  const migrationRef = ref(realtimeDb, `users/${uid}/migrations/firestoreTasksV1`);
  const migrationSnapshot = await getRealtimeValue(migrationRef);
  if (migrationSnapshot.exists()) return { migrated: false, copied: 0 };

  const [firestoreSnapshot, existingTasksSnapshot] = await Promise.all([
    getDocs(collection(db, "users", uid, "tasks")),
    getRealtimeValue(tasksRef(uid))
  ]);
  const existingTasks = existingTasksSnapshot.val() || {};
  const migratedTasks = {};

  for (const taskSnapshot of firestoreSnapshot.docs) {
    if (Object.prototype.hasOwnProperty.call(existingTasks, taskSnapshot.id)) continue;
    migratedTasks[taskSnapshot.id] = serializeTask(taskSnapshot.data());
  }

  if (Object.keys(migratedTasks).length) {
    await update(tasksRef(uid), migratedTasks);
  }
  await set(migrationRef, {
    completedAt: serverTimestamp(),
    copiedCount: Object.keys(migratedTasks).length
  });
  return { migrated: true, copied: Object.keys(migratedTasks).length };
}

export async function saveTask(uid, data, taskId = null) {
  const payload = {
    ...data,
    startAt: data.startAt || null,
    dueAt: data.dueAt || null,
    checklist: Array.isArray(data.checklist) ? data.checklist : [],
    subtasks: Array.isArray(data.subtasks) ? data.subtasks : [],
    favorite: Boolean(data.favorite),
    deletedAt: data.deletedAt || null,
    updatedAt: serverTimestamp()
  };

  if (taskId) {
    await update(taskRef(uid, taskId), serializeTask(payload));
  } else {
    const newTaskRef = push(tasksRef(uid));
    await set(newTaskRef, serializeTask({
      ...payload,
      createdAt: serverTimestamp(),
      status: data.status || "pending",
      reminderSentAt: null
    }));
  }
}

export async function setTaskStatus(uid, taskId, status) {
  const taskSnapshot = await getRealtimeValue(taskRef(uid, taskId));
  if (!taskSnapshot.exists()) throw new Error("Không tìm thấy công việc.");

  const task = deserializeTask(taskSnapshot.val());
  const completed = status === "completed";
  await update(taskRef(uid, taskId), serializeTask({
    status,
    checklist: task.checklist.map(item => ({ ...item, completed })),
    subtasks: task.subtasks.map(item => ({ ...item, status: completed ? "completed" : "pending" })),
    updatedAt: serverTimestamp()
  }));
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

export async function permanentlyDeleteTask(uid, taskId) {
  await remove(taskRef(uid, taskId));
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
    updatedAt: serverTimestamp()
  }));
}

export function duplicateTaskDraft(task) {
  const { id, createdAt, updatedAt, deletedAt, ...copy } = task;
  return {
    ...copy,
    title: String(task.title || "Công việc"),
    status: "pending",
    favorite: false,
    deletedAt: null,
    reminderAt: null,
    reminderSentAt: null,
    notificationClaimedAt: null,
    checklist: (task.checklist || []).map(item => ({ ...item, completed: false })),
    subtasks: (task.subtasks || []).map(item => ({ ...item, status: "pending" }))
  };
}
