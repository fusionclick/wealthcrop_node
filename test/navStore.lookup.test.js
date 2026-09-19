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

// A wrong or stale ISIN resolves to a real price belonging to a different plan. Valuing
// with it produced +2350% on an 18,000 holding during a regression pass — a number an
// investor would act on — so the valuation refuses anything far from the cost basis.
describe("navLooksPlausible guards the valuation", () => {
  const { navLooksPlausible } = require("../src/mf/navStore");

  it("accepts a price near what was paid per unit", () => {
    // 10,000 over 200 units = 50/unit.
    assert.equal(navLooksPlausible(10000, 200, 50), true);
    assert.equal(navLooksPlausible(10000, 200, 89.86), true, "a genuine 80% gain is still plausible");
    assert.equal(navLooksPlausible(10000, 200, 240), true, "5x exactly is the boundary, still in");
  });

  it("refuses a price that belongs to another scheme", () => {
    assert.equal(navLooksPlausible(10000, 200, 1202.675), false, "24x the cost basis");
    assert.equal(navLooksPlausible(10000, 200, 2), false, "and the same in the other direction");
  });

  it("refuses a missing or nonsense price outright", () => {
    for (const bad of [null, undefined, 0, -5, NaN, "abc"]) {
      assert.equal(navLooksPlausible(10000, 200, bad), false);
    }
  });

  it("with no cost basis there is nothing to compare, so the price stands", () => {
    assert.equal(navLooksPlausible(0, 0, 1202.675), true);
    assert.equal(navLooksPlausible(null, null, 50), true);
  });
});
