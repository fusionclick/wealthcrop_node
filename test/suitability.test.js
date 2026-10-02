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
    // Driven off REQUIRED_ACKS rather than a hardcoded pair: the AMFI consent matrix added
    // three more keys, and a test that names them by hand goes stale every time compliance
    // changes — which is the moment it most needs to be right.
    const [first, ...rest] = REQUIRED_ACKS;
    const v = checkDisclaimers({ acknowledged: [first] });
    assert.equal(v.ok, false);
    assert.deepEqual(v.required, rest);
  });

  it("accepts an array or an object of flags", () => {
    const allTrue = Object.fromEntries(REQUIRED_ACKS.map((k) => [k, true]));
    assert.equal(checkDisclaimers({ acknowledged: REQUIRED_ACKS }).ok, true);
    assert.equal(checkDisclaimers({ acknowledged: allTrue }).ok, true);
    assert.equal(
      checkDisclaimers({ acknowledged: { ...allTrue, [REQUIRED_ACKS[0]]: false } }).ok,
      false,
      "an explicit false is not an acknowledgement"
    );
  });

  it("the AMFI consent matrix is part of what must be ticked", () => {
    // §2 rows 1, 3 and 4. Each is a statement the investor MAKES, not a notice they are
    // shown, so each has to be in the gate or the eight-year consent log records a tick
    // that nothing ever enforced.
    for (const key of ["execution_only", "regular_plan_commission", "scheme_documents"]) {
      assert.ok(REQUIRED_ACKS.includes(key), `${key} is not gated`);
    }
    // AMFI publishes the execution-only wording; the parts that carry the meaning must survive
    // any rewording through the env override.
    assert.match(DISCLAIMERS.execution_only, /execution-only/i);
    assert.match(DISCLAIMERS.execution_only, /^You are processing an Execution-Only transaction\. This scheme selection has been made independently by you without any advice from /);
    assert.match(DISCLAIMERS.regular_plan_commission, /trail commission/i);
    assert.match(DISCLAIMERS.regular_plan_commission, /AMFI-registered Mutual Fund Distributor/i);
    assert.match(DISCLAIMERS.scheme_documents, /SID/);
    assert.match(DISCLAIMERS.scheme_documents, /SAI/);
    assert.match(DISCLAIMERS.scheme_documents, /KIM/);
    // §1.B "No Guarantees" in full — shown at checkout, not ticked.
    assert.match(DISCLAIMERS.no_guarantee, /do not offer assured or guaranteed returns/i);
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

// ── Audit #31/#33/#34: plan, RM-assisted declaration, entity name ───────────────────────

describe("Audit #31: Regular plans only", () => {
  it("a Direct plan is refused whatever the investor's profile", () => {
    const v = checkSuitability(investor("Aggressive"), { plan: "Direct", category: "Debt" });
    assert.equal(v.ok, false);
    assert.equal(v.code, "direct_plan_not_offered");
  });

  it("a Regular plan, or a row that names no plan, is judged on risk as before", () => {
    assert.equal(checkSuitability(investor("Aggressive"), { plan: "Regular", category: "Equity" }).ok, true);
    assert.equal(checkSuitability(investor("Aggressive"), { category: "Equity" }).ok, true);
  });
});

describe("Audit #33: the RM-assisted declaration", () => {
  const rms = [{ euin: "E123456", name: "Asha" }];
  const withRm = (euin) => [...REQUIRED_ACKS.filter((k) => k !== "execution_only"), `rm_assisted:${euin}`];

  it("stands in for execution_only when it names someone on the register", () => {
    assert.deepEqual(checkDisclaimers({ acknowledged: withRm("e123456") }, { rms }), { ok: true, euin: "E123456" });
    assert.deepEqual(checkDisclaimers({ acknowledged: REQUIRED_ACKS }, { rms }), { ok: true, euin: "" });
  });

  it("an EUIN that is not on the register is refused — an empty register refuses them all", () => {
    assert.equal(checkDisclaimers({ acknowledged: withRm("E000001") }, { rms }).code, "rm_not_registered");
    assert.equal(checkDisclaimers({ acknowledged: withRm("E123456") }).code, "rm_not_registered");
  });

  it("both declarations at once, or two RMs, is a contradiction", () => {
    assert.equal(checkDisclaimers({ acknowledged: [...REQUIRED_ACKS, "rm_assisted:E123456"] }, { rms }).code, "rm_declaration_conflict");
    assert.equal(
      checkDisclaimers({ acknowledged: [...withRm("E123456"), "rm_assisted:E654321"] }, { rms: [...rms, { euin: "E654321" }] }).code,
      "rm_declaration_conflict"
    );
  });

  it("a bare rm_assisted with no EUIN declares nothing", () => {
    const v = checkDisclaimers({ acknowledged: [...REQUIRED_ACKS.filter((k) => k !== "execution_only"), "rm_assisted"] }, { rms });
    assert.equal(v.ok, false);
    assert.deepEqual(v.required, ["execution_only"]);
  });

  it("the RM text has the slots the checkout fills", () => {
    assert.match(DISCLAIMERS.rm_assisted, /\{rm\}/);
    assert.match(DISCLAIMERS.rm_assisted, /\{euin\}/);
  });
});

describe("Audit #34: no invented legal entity", () => {
  it("names AMFI's 'the distributor' until the panel supplies the real name", (t) => {
    if (process.env.LEGAL_ENTITY_NAME || process.env.DISCLAIMER_EXECUTION_ONLY) return t.skip("an env override is set");
    assert.doesNotMatch(DISCLAIMERS.execution_only, /Wealthcrop Advisory/i);
    assert.match(DISCLAIMERS.execution_only, /the distributor/);
  });

  it("the identity line needs BOTH the entity and the ARN", () => {
    const { identityLine } = require("../src/mf/distributor");
    assert.equal(identityLine("", "ARN-1"), "");
    assert.equal(identityLine("X Ltd", ""), "");
    assert.equal(identityLine("X Ltd", "ARN-1"), "X Ltd | AMFI-registered Mutual Fund Distributor | ARN: ARN-1");
  });
});
