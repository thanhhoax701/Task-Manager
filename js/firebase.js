import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

export const firebaseConfig = {
  apiKey: "AIzaSyAn_7gNolTMiZdT_TvwGPk4AK5zXgQUoyI",
  authDomain: "taskmanager-83fd6.firebaseapp.com",
  projectId: "taskmanager-83fd6",
  databaseURL: "https://taskmanager-83fd6-default-rtdb.firebaseio.com",
  storageBucket: "taskmanager-83fd6.firebasestorage.app",
  messagingSenderId: "859745820284",
  appId: "1:859745820284:web:b554357241a045d46173f9",
  measurementId: "G-HBFH7CQCZS"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const realtimeDb = getDatabase(app);
