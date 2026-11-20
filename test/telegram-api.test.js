const test = require("node:test");
const assert = require("node:assert/strict");
const databaseRules = require("../database.rules.json");
const telegramLink = require("../api/telegram-link");
const telegramReminders = require("../api/telegram-reminders");
const telegramWebhook = require("../api/telegram-webhook");

test("Telegram link-code expiry index is configured at the database root", () => {
  assert.deepEqual(databaseRules.rules.telegramLinkCodes[".indexOn"], ["expiresAt"]);
  assert.equal(databaseRules.rules.users.telegramLinkCodes, undefined);
});

function createResponse() {
  return {
    code: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("Telegram link endpoint requires POST and a Firebase bearer token", async () => {
  const methodResponse = createResponse();
  await telegramLink({ method: "GET", headers: {} }, methodResponse);
  assert.equal(methodResponse.code, 405);
  assert.equal(methodResponse.headers.Allow, "POST");

  const authResponse = createResponse();
  await telegramLink({ method: "POST", headers: {} }, authResponse);
  assert.equal(authResponse.code, 401);
});

test("Telegram webhook rejects updates without its configured secret", async t => {
  const previous = process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = previous;
  });
  const response = createResponse();
  await telegramWebhook({ method: "POST", headers: {}, body: {} }, response);
  assert.equal(response.code, 401);
});

test("reminder endpoint rejects unauthenticated requests before Firebase access", async t => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
  const response = createResponse();
  await telegramReminders({ method: "GET", headers: {} }, response);
  assert.equal(response.code, 401);
});
