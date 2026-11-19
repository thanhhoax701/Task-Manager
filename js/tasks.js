import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";

export function subscribeTasks(uid, callback, onError) {
  const q = query(collection(db, "users", uid, "tasks"), orderBy("createdAt", "desc"));
  return onSnapshot(q, snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
}

export async function saveTask(uid, data, taskId = null) {
  const payload = {
    ...data,
    updatedAt: serverTimestamp()
  };
  if (taskId) {
    await updateDoc(doc(db, "users", uid, "tasks", taskId), payload);
  } else {
    payload.createdAt = serverTimestamp();
    payload.status = "pending";
    payload.reminderSentAt = null;
    await addDoc(collection(db, "users", uid, "tasks"), payload);
  }
}

export async function setTaskStatus(uid, taskId, status) {
  await updateDoc(doc(db, "users", uid, "tasks", taskId), {
    status, updatedAt: serverTimestamp()
  });
}

export async function removeTask(uid, taskId) {
  await deleteDoc(doc(db, "users", uid, "tasks", taskId));
}
