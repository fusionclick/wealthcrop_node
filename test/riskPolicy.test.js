// Ticket 23 — the risk ceilings are now admin-configurable. What matters is that making
// them configurable did not make them weaker: a bad value, or a Laravel outage, must never
// end up permitting MORE than the built-in policy.
const test = require("node:test");
const assert = require("node:assert");

const { normalise, DEFAULTS, peekRiskPolicy } = require("../src/mf/riskPolicy");
const { checkSuitability } = require("../src/mf/suitability");

const conservative = { riskProfile: { profile: "conservative" } };
const veryHighFund = { risk: "Very High", category: "Equity", subType: "Flexi Cap" };
const moderateFund = { risk: "Moderate", category: "Equity", subType: "Large Cap" };

test("a configured policy is used as given", () => {
  assert.deepStrictEqual(normalise({ conservative: 2, moderate: 4, aggressive: 5 }), {
    conservative: 2,
    moderate: 4,
    aggressive: 5,
  });
});

test("a ceiling outside SEBI's 1-6 is a typo, not a policy — the default stands", () => {
  const out = normalise({ conservative: 0, moderate: 99, aggressive: "yes" });
  assert.deepStrictEqual(out, DEFAULTS);

  // Non-integers too: 3.5 is not a riskometer level.
  assert.strictEqual(normalise({ conservative: 3.5 }).conservative, DEFAULTS.conservative);
});

test("an empty response falls back to the built-in policy, never to 'anything goes'", () => {
  assert.deepStrictEqual(normalise({}), DEFAULTS);
  assert.deepStrictEqual(normalise(), DEFAULTS);
});

test("before Laravel has ever answered, the cached policy is the built-in one", () => {
  assert.deepStrictEqual(peekRiskPolicy(), DEFAULTS);
});

test("the gate honours the policy it is handed", () => {
  // Default: a conservative investor tops out at Moderate (3).
  assert.strictEqual(checkSuitability(conservative, moderateFund, DEFAULTS).ok, true);
  assert.strictEqual(checkSuitability(conservative, veryHighFund, DEFAULTS).ok, false);

  // Widened by an admin to the top of the scale, the same order goes through.
  const widened = { ...DEFAULTS, conservative: 6 };
  assert.strictEqual(checkSuitability(conservative, veryHighFund, widened).ok, true);

  // Tightened, the previously-fine Moderate fund is refused.
  const tightened = { ...DEFAULTS, conservative: 1 };
  const res = checkSuitability(conservative, moderateFund, tightened);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, "risk_level_unsuitable");
});

test("no profile is still a hard block, whatever the policy says", () => {
  const res = checkSuitability({}, moderateFund, { conservative: 6, moderate: 6, aggressive: 6 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, "risk_profile_missing");
});
