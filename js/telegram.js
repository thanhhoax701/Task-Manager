import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { functions } from "./functions-client.js";

export async function createTelegramLink() {
  const createLink = httpsCallable(functions, "createTelegramLinkCode");
  const result = await createLink({});
  return result.data;
}

export function subscribeTelegram(uid, callback, onError) {
  return onSnapshot(doc(db, "users", uid, "private", "telegram"), snap => {
    callback(snap.exists() ? snap.data() : null);
  }, onError);
}
