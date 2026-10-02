const test = require('node:test');
const assert = require('node:assert/strict');
const { configData } = require('../src/config');
const { requireLiveBse } = require('../src/middleware/requireInvestor');

test('production refuses UAT actions and incomplete live onboarding', () => {
  const before = { mode: process.env.NODE_ENV, url: configData.baseUrl };
  const probe = (path) => {
    const out = { continued: false };
    const res = { status(code) { out.http = code; return this; }, json(body) { out.code = body.code; } };
    requireLiveBse({ path }, res, () => { out.continued = true; });
    return out;
  };
  try {
    process.env.NODE_ENV = 'production';
    configData.baseUrl = 'https://starmfv2demo.bseindia.com';
    assert.equal(probe('/purchaseNewOrder').code, 'BSE_LIVE_UNAVAILABLE');
    configData.baseUrl = 'https://exchange.example.org';
    assert.equal(probe('/purchaseNewOrder').continued, true);
    assert.equal(probe('/v2/add_ucc').code, 'LIVE_ONBOARDING_UNAVAILABLE');
    process.env.NODE_ENV = 'test';
    assert.equal(probe('/v2/add_ucc').continued, true);
  } finally {
    configData.baseUrl = before.url;
    if (before.mode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before.mode;
  }
});
