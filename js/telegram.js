import { TELEGRAM_BOT_USERNAME } from "./config.js";

export function createTelegramLink() {
  return `https://t.me/${TELEGRAM_BOT_USERNAME}`;
}
