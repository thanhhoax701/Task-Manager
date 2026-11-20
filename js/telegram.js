import { TELEGRAM_BOT_USERNAME } from "./config.js";

export function createTelegramLink(startParameter = "") {
  const link = new URL(`https://t.me/${TELEGRAM_BOT_USERNAME}`);
  if (startParameter) link.searchParams.set("start", startParameter);
  return link.href;
}
