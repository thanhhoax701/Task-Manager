const test = require("node:test");
const assert = require("node:assert/strict");
const databaseRules = require("../database.rules.json");
const adminUsers = require("../api/admin-users");
const bootstrapAdmin = require("../api/bootstrap-admin");
const taskCollaboration = require("../api/task-collaboration");

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

test("Admin and collaboration APIs require POST and an authenticated user", async () => {
  for (const handler of [adminUsers, bootstrapAdmin, taskCollaboration]) {
    const methodResponse = createResponse();
    await handler({ method: "GET", headers: {} }, methodResponse);
    assert.equal(methodResponse.code, 405);

    const authResponse = createResponse();
    await handler({ method: "POST", headers: {}, body: {} }, authResponse);
    assert.equal(authResponse.code, 401);
  }
});

test("collaboration metadata is server-written and scoped to owners or members", () => {
  const rules = databaseRules.rules;
  assert.equal(rules.taskMembers["$taskId"][".write"], false);
  assert.equal(rules.taskMemberships["$uid"][".write"], false);
  assert.equal(rules.taskComments["$taskId"][".write"], false);
  assert.equal(rules.taskProgress["$taskId"][".write"], false);
  assert.match(rules.users["$uid"].tasks["$taskId"][".read"], /taskMembers/);
});
