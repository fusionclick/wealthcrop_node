const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  checkSuitability,
  checkDisclaimers,
  investorProfileOf,
  DISCLAIMERS,
  REQUIRED_ACKS,
  RISK_POLICY,
} = require("../src/mf/suitability");

const investor = (profile) => (profile ? { riskProfile: { profile } } : {});

// ── ticket 23: reading the profile Laravel stores ────────────────────────────────────

describe("investor risk profile", () => {
  it("reads UserRiskProfile.profile however the questionnaire spelled it", () => {
    assert.equal(investorProfileOf(investor("Conservative")), "conservative");
    assert.equal(investorProfileOf(investor("Moderate")), "moderate");
    assert.equal(investorProfileOf(investor("Aggressive")), "aggressive");
    assert.equal(investorProfileOf(investor("Balanced")), "moderate");
    assert.equal(investorProfileOf(investor("Growth")), "aggressive");
    assert.equal(investorProfileOf({ risk_profile: { category: "Cautious" } }), "conservative");
  });

  it("an absent or unrecognised profile is null, not a default", () => {
    // Defaulting to "moderate" would let an investor who never answered the questionnaire
    // buy, which is the thing ticket 24 exists to stop.
    assert.equal(investorProfileOf({}), null);
    assert.equal(investorProfileOf(investor("")), null);
    assert.equal(investorProfileOf(investor("purple")), null);
  });
});

// ── ticket 24: gating the order ──────────────────────────────────────────────────────

describe("ticket 24: risk-based order gating", () => {
  it("no risk profile blocks the order outright", () => {
    const v = checkSuitability({}, { risk: "Low", category: "Debt" });
    assert.equal(v.ok, false);
    assert.equal(v.code, "risk_profile_missing");
  });

  it("a fund above the investor's ceiling is blocked, and the message says why", () => {
    const v = checkSuitability(investor("Conservative"), { risk: "Very High", category: "Equity" });
    assert.equal(v.ok, false);
    assert.equal(v.code, "risk_level_unsuitable");
    assert.match(v.message, /Very High/);
    assert.match(v.message, /conservative/);
  });

  it("uses SEBI's six levels, not three buckets", () => {
    // The browser's old mapping collapsed everything above "moderate" into one bucket, so
    // Moderately High and Very High were the same answer for a moderate investor.
    const moderate = investor("Moderate");
    assert.equal(checkSuitability(moderate, { risk: "Moderately High", category: "Equity" }).ok, true);
    assert.equal(checkSuitability(moderate, { risk: "High", category: "Equity" }).ok, false);
    assert.equal(RISK_POLICY.moderate, 4);
  });

  it("an aggressive investor may buy the top of the riskometer", () => {
    assert.equal(checkSuitability(investor("Aggressive"), { risk: "Very High", category: "Equity" }).ok, true);
  });

  it("concentrated funds are aggressive-only whatever the riskometer says", () => {
    for (const category of ["Equity • Small Cap", "Sectoral", "Thematic"]) {
      assert.equal(checkSuitability(investor("Moderate"), { risk: "High", category }).ok, false, category);
      assert.equal(checkSuitability(investor("Aggressive"), { risk: "High", category }).ok, true, category);
    }
  });

  it("mid cap and ELSS are closed to a conservative investor", () => {
    assert.equal(checkSuitability(investor("Conservative"), { category: "Equity • Mid Cap" }).ok, false);
    assert.equal(checkSuitability(investor("Conservative"), { category: "ELSS" }).ok, false);
    assert.equal(checkSuitability(investor("Moderate"), { category: "ELSS" }).ok, true);
  });

  it("debt and liquid funds suit everyone", () => {
    for (const category of ["Debt", "Liquid", "Overnight", "Gilt", "Money Market"]) {
      assert.equal(checkSuitability(investor("Conservative"), { category, risk: "High" }).ok, true, category);
    }
  });

  it("an unknown riskometer level does not block the order", () => {
    // Fail-open on the scheme: the enrichment source is rate-limited and fail-open, so a
    // missing level means "we could not look it up", not "this is dangerous". Blocking
    // there would stop honest orders for a reason the investor cannot act on.
    assert.equal(checkSuitability(investor("Conservative"), { risk: null, category: "Equity" }).ok, true);
    assert.equal(checkSuitability(investor("Conservative"), { risk: "banana", category: "Equity" }).ok, true);
  });

  it("but an unknown level still meets the category rules", () => {
    assert.equal(checkSuitability(investor("Conservative"), { risk: null, category: "Small Cap" }).ok, false);
  });
});

// ── ticket 22: disclaimers ───────────────────────────────────────────────────────────

describe("ticket 22: disclaimer acknowledgement", () => {
  it("an order with no acknowledgement is refused", () => {
    const v = checkDisclaimers({});
    assert.equal(v.ok, false);
    assert.equal(v.code, "disclaimer_not_acknowledged");
    assert.deepEqual(v.required, REQUIRED_ACKS);
  });

  it("a partial acknowledgement names what is still missing", () => {
    const v = checkDisclaimers({ acknowledged: ["market_risk"] });
    assert.equal(v.ok, false);
    assert.deepEqual(v.required, ["past_performance"]);
  });

  it("accepts an array or an object of flags", () => {
    assert.equal(checkDisclaimers({ acknowledged: REQUIRED_ACKS }).ok, true);
    assert.equal(checkDisclaimers({ acknowledged: { market_risk: true, past_performance: true } }).ok, true);
    assert.equal(
      checkDisclaimers({ acknowledged: { market_risk: true, past_performance: false } }).ok,
      false,
      "an explicit false is not an acknowledgement"
    );
  });

  it("a truthy non-flag does not count as acknowledgement", () => {
    assert.equal(checkDisclaimers({ acknowledged: true }).ok, false);
    assert.equal(checkDisclaimers({ acknowledged: "yes" }).ok, false);
  });

  it("every required key has text to show, and SEBI's warning is among them", () => {
    for (const key of REQUIRED_ACKS) {
      assert.ok(DISCLAIMERS[key], `no text for the required acknowledgement "${key}"`);
    }
    assert.match(DISCLAIMERS.market_risk, /subject to market risks/i);
    assert.match(DISCLAIMERS.past_performance, /past performance/i);
  });
});
