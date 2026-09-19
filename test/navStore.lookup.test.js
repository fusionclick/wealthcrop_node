const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { navFor, navDateFor } = require("../src/mf/navStore");

// getNavs() returns { at, loaded, date, navs } but every lookup helper wants the flat map
// inside it. Passing the wrapper reads perfectly and resolves nothing — the store sits there
// fully loaded while every price comes back null. That shipped once; this stops it silently
// shipping again.
describe("NAV lookup accepts either shape", () => {
  const flat = { INF879O01027: { nav: 84.21, date: "20-Sep-2026" } };
  const store = { at: Date.now(), loaded: true, date: "20-Sep-2026", navs: flat };

  it("resolves from the flat map", () => {
    assert.equal(navFor(flat, "INF879O01027", null), 84.21);
  });

  it("resolves from the whole store, the thing getNavs actually hands back", () => {
    assert.equal(navFor(store, "INF879O01027", null), 84.21);
    assert.equal(navDateFor(store, "INF879O01027", null), "20-Sep-2026");
  });

  it("falls back to the scheme code, and is case-insensitive", () => {
    const byCode = { "PP001ZG-GR": { nav: 12.5, date: "20-Sep-2026" } };
    assert.equal(navFor(byCode, null, "pp001zg-gr"), 12.5);
  });

  it("an unknown scheme is null, not zero", () => {
    assert.equal(navFor(store, "INFNOPE00001", "NOPE"), null);
  });

  it("no store at all does not throw", () => {
    assert.equal(navFor(undefined, "INF879O01027", null), null);
    assert.equal(navFor({}, "INF879O01027", null), null);
  });
});
