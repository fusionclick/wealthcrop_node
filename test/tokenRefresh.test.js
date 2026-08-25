const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("../src/controllers/StarMFController");

// BSE ka gateway expired token par 401 + HTML deta hai, aur SDK usay throw nahi karta.
// Ye check pakadta hai ke wo 401 naya token le kar request dobara bhejta hai — warna
// token container restart tak mara rehta hai aur har BSE call khali/502 ho jati hai.
describe("BSE token refresh", () => {
  const ax = controller.masterDataService.api._axios;
  const authOf = (config) =>
    String(
      (config.headers && typeof config.headers.get === "function"
        ? config.headers.get("Authorization")
        : config.headers?.Authorization) || ""
    );

  const stubLogin = (counter) => {
    controller.loginFunc = async () => {
      counter.logins += 1;
      controller.accessToken = "FRESH";
      return { status: "success" };
    };
  };

  it("refreshes and replays once when BSE answers 401", async () => {
    const seen = [];
    const counter = { logins: 0 };
    controller.accessToken = "STALE";
    controller.loginInflight = null;
    stubLogin(counter);
    ax.defaults.adapter = async (config) => {
      seen.push(authOf(config));
      if (seen.length === 1) {
        const err = new Error("Request failed with status code 401");
        err.config = config;
        err.response = { status: 401, data: "<html>401 Authorization Required</html>" };
        throw err;
      }
      return { status: 200, statusText: "OK", headers: {}, config, data: { data: { lists: [{ name: "OK" }] } } };
    };

    const res = await controller.masterDataService.getSchemeMasterList("STALE", { data: {} });

    assert.equal(counter.logins, 1);
    assert.equal(seen.length, 2, "request should be sent exactly twice");
    assert.match(seen[0], /STALE/);
    assert.match(seen[1], /FRESH/, "retry must carry the new token, not the dead one");
    assert.equal(res.data.lists[0].name, "OK");
  });

  it("gives up after one retry instead of looping on a bad login", async () => {
    const counter = { logins: 0 };
    let attempts = 0;
    controller.accessToken = "STALE";
    controller.loginInflight = null;
    stubLogin(counter);
    ax.defaults.adapter = async (config) => {
      attempts += 1;
      const err = new Error("Request failed with status code 401");
      err.config = config;
      err.response = { status: 401, data: "<html>401 Authorization Required</html>" };
      throw err;
    };

    await controller.masterDataService.getSchemeMasterList("STALE", { data: {} });

    assert.equal(attempts, 2, "one original + one retry, no infinite loop");
    assert.equal(counter.logins, 1);
  });

  it("logs in once when several calls hit 401 together", async () => {
    const counter = { logins: 0 };
    let first = true;
    controller.accessToken = "STALE";
    controller.loginInflight = null;
    stubLogin(counter);
    ax.defaults.adapter = async (config) => {
      if (first || authOf(config).includes("STALE")) {
        first = false;
        const err = new Error("Request failed with status code 401");
        err.config = config;
        err.response = { status: 401, data: "<html>401 Authorization Required</html>" };
        throw err;
      }
      return { status: 200, statusText: "OK", headers: {}, config, data: { ok: true } };
    };

    await Promise.all(
      [1, 2, 3, 4].map(() => controller.masterDataService.getSchemeMasterList("STALE", { data: {} }))
    );

    // BSE ek hi session rakhta hai — 4 parallel logins purane token ko maar dete.
    assert.equal(counter.logins, 1);
  });
});
