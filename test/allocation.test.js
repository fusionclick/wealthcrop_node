const test = require('node:test');
const assert = require('node:assert/strict');

test('scheduled reviews reuse the same bounded allocation engine as the browser', async () => {
  const engine = await import('../src/mf/allocation.mjs');
  for (const risk of engine.RISK_PROFILES) {
    const plan = engine.reviewedPlan({ risk, lifeStage: 'mid', horizonYears: 2, monthlyAmount: 10000 });
    assert.equal(Object.values(plan.allocation).reduce((sum, n) => sum + n, 0), 100);
    assert.ok(plan.allocation.equity <= 20, 'a short horizon must constrain equity even for an aggressive profile');
    assert.ok(plan.rationale.length > 0);
    assert.ok(plan.sleeves.every((s) => s.amount >= 0));
  }
});
