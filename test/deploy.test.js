const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

test("backend auto-update unit cannot be overwritten by frontend", () => {
  const script = readFileSync("deploy/install-autoupdate.sh", "utf8");
  assert.match(script, /wc-backend-image-update/);
  assert.doesNotMatch(script, /cat >\/etc\/systemd\/system\/wc-image-update\.service/);
});
