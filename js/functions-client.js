import { getFunctions } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { app } from "./firebase.js";

// Phải trùng region đã khai báo trong functions/src/index.ts
export const functions = getFunctions(app, "asia-southeast1");
