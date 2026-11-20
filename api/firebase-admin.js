const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { getFirestore } = require("firebase-admin/firestore");

const ADMIN_APP_NAME = "task-manager-vercel-reminders";
const DATABASE_URL = "https://taskmanager-83fd6-default-rtdb.firebaseio.com";

function getFirebaseServices() {
  let app = getApps().find(candidate => candidate.name === ADMIN_APP_NAME);
  if (!app) {
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!rawServiceAccount) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT.");
    app = initializeApp({
      credential: cert(JSON.parse(rawServiceAccount)),
      databaseURL: process.env.FIREBASE_DATABASE_URL || DATABASE_URL
    }, ADMIN_APP_NAME);
  }
  return {
    auth: getAuth(app),
    database: getDatabase(app),
    firestore: getFirestore(app)
  };
}

module.exports = { getFirebaseServices };
