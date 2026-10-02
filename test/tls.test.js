const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

test("UAT and the legacy insecure flag cannot disable certificate verification globally", () => {
  const script = `const c=require('./src/config'); const a=require('axios');
    require('node:assert/strict').equal(c.bseHttpsAgent.options.rejectUnauthorized,true);
    require('node:assert/strict').notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0');
    require('node:assert/strict').notEqual(a.defaults.httpsAgent?.options.rejectUnauthorized,false);`;
  assert.doesNotThrow(() => execFileSync(process.execPath, ["-e", script], {
    cwd: require("node:path").resolve(__dirname, ".."),
    env: { ...process.env, BSE_BASE_URL: "https://starmfv2demo.bseindia.com", BSE_TLS_INSECURE: "1", NODE_TLS_REJECT_UNAUTHORIZED: "1" },
  }));
});
