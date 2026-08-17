const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBseBaseUrl } = require("../src/config");
const { isTransactable, mapScheme, parseListQuery, matchesCategory, paginate } = require("../src/mf/scheme");
const { uccMatches, validateOrder, checkSchemeLimits, normalizeOrder, bindUcc } = require("../src/mf/order");

describe("catalogue", () => {
  it("drops inactive and purchase-blocked schemes", () => {
    assert.equal(isTransactable({ scheme_status: "active", purchase_allowed: "Y" }), true);
    assert.equal(isTransactable({ scheme_status: "inactive" }), false);
    assert.equal(isTransactable({ purchase_allowed: "N" }), false);
    assert.equal(isTransactable({}), true);
  });

  it("maps BSE fields without invented AUM/ratings", () => {
    const mapped = mapScheme({
      scheme_name: "SBI Growth",
      scheme_isin: "INF123",
      scheme_bse_code: "007G",
      scheme_category: "Equity",
      min_lumpsum_amount: 5000,
    });
    assert.equal(mapped.name, "SBI Growth");
    assert.equal(mapped.scheme_bse_code, "007G");
    assert.equal(mapped.minLumpsum, 5000);
    assert.equal(mapped.fundSize, undefined);
    assert.equal(mapped.rating, undefined);
    assert.equal(mapped.returns["3Y"], null);
  });

  it("paginates and parses list query", () => {
    const q = parseListQuery({ start: 20, length: 10, search: "gold" });
    assert.deepEqual(q, { start: 20, length: 10, search: "gold", category: "", isin: "", scheme_code: "" });
    assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), [3, 4]);
    assert.equal(matchesCategory({ name: "HDFC Large Cap", subType: "Equity • Large Cap" }, "large_cap"), true);
    assert.equal(matchesCategory({ name: "Nippon Gold", subType: "Commodity" }, "gold_funds"), true);
  });

  it("falls back from unresolved prod host to demo", () => {
    assert.equal(resolveBseBaseUrl("https://starmfv2.bseindia.com"), "https://starmfv2demo.bseindia.com");
    assert.equal(resolveBseBaseUrl("https://starmfv2demo.bseindia.com"), "https://starmfv2demo.bseindia.com");
  });
});

describe("orders", () => {
  const investor = { kyc: { ucc_code: "USRWC003" } };

  it("binds UCC and rejects mismatch", () => {
    assert.equal(uccMatches(investor, {}).ok, true);
    assert.equal(uccMatches(investor, { data: { orders: [{ investor: { ucc: "OTHER" } }] } }).ok, false);
    assert.equal(uccMatches({ kyc: {} }, {}).ok, false);
  });

  it("validates purchase", () => {
    assert.equal(validateOrder({}).ok, false);
    assert.equal(validateOrder({ data: { orders: [{ type: "p", scheme: "007G", amount: 0 }] } }).ok, false);
    const ok = validateOrder({ data: { orders: [{ type: "p", scheme: "007G", amount: 5000 }] } });
    assert.equal(ok.ok, true);
    const minFail = checkSchemeLimits(ok.order, { min_lumpsum_amount: 10000, purchase_allowed: "Y" });
    assert.equal(minFail.ok, false);
    const minOk = checkSchemeLimits(ok.order, { min_lumpsum_amount: 1000, purchase_allowed: "Y" });
    assert.equal(minOk.ok, true);
    const blocked = checkSchemeLimits(ok.order, { purchase_allowed: "N" });
    assert.equal(blocked.ok, false);
  });

  it("validates redemption", () => {
    assert.equal(validateOrder({ data: { orders: [{ type: "r", scheme: "007G", amount: 100 }] } }).ok, false);
    const ok = validateOrder({ data: { orders: [{ type: "r", scheme: "007G", amount: 100, folio: "123" }] } });
    assert.equal(ok.ok, true);
    const all = validateOrder({ data: { orders: [{ type: "r", scheme: "007G", all_units: true, folio: "123" }] } });
    assert.equal(all.ok, true);
  });

  it("normalizes member and UCC", () => {
    const n = normalizeOrder({ type: "p", scheme: "007G", amount: 5000 }, { ucc: "USRWC003", memberCode: "91010" });
    assert.equal(n.investor.ucc, "USRWC003");
    assert.equal(n.member, "91010");
    const bound = bindUcc({ data: { investor: { ucc: "X" }, order_ids: [1] } }, "USRWC003", "91010");
    assert.equal(bound.data.investor.ucc, "USRWC003");
  });
});
