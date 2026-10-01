const axios = require("axios");
const { configData } = require("../config");

/**
 * QA 13.7 — the platform's own minimum investment amounts (admin panel → Settings →
 * Commission & Investment Limits).
 *
 * These were saved by the admin, returned by /platform-settings, and read by nothing at
 * all: the only consumer of that endpoint is ModuleGate, which wants the equity/F&O
 * switches. So an admin could set "Min Lumpsum ₹5,000", watch it save, and place a ₹500
 * order a minute later. QA reported that as "changing lumpsum and SIP is not working",
 * which is exactly what it was.
 *
 * The number is a FLOOR on top of whatever BSE says the scheme's own minimum is — never a
 * replacement for it. A platform that wants a higher bar than the AMC can set one; it can
 * never let an order through that the AMC would reject.
 *
 * ── Failure behaviour: fails OPEN ────────────────────────────────────────────────────────
 * Same shape as riskPolicy.js, opposite default, and deliberately so. A risk ceiling that
 * goes missing must not widen what an investor may buy, so that one keeps the last good
 * value and falls back to conservative defaults. This is a house rule sitting ON TOP of a
 * limit BSE already enforces: if Laravel is unreachable, applying a floor we cannot read —
 * or guessing 500 — would block orders that are perfectly valid. Zero means "no house rule
 * today"; the scheme's own minimum still applies, as it always did.
 */

const url = () => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "/platform-settings");

const TTL_MS = 5 * 60 * 1000;
const NONE = Object.freeze({ minLumpsum: 0, minSip: 0 });

let cache = { at: 0, limits: NONE };
let inFlight = null;

/** A negative or unparseable limit is a typo, not a rule. */
const clean = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

async function load() {
  const res = await axios.get(url(), { timeout: 8000 });
  const data = res?.data?.data || {};
  return {
    at: Date.now(),
    limits: Object.freeze({
      minLumpsum: clean(data.min_lumpsum_amount),
      minSip: clean(data.min_sip_amount),
    }),
  };
}

async function getLimits() {
  if (Date.now() - cache.at < TTL_MS) return cache.limits;
  if (!inFlight) {
    inFlight = load()
      .then((fresh) => {
        cache = fresh;
        return cache.limits;
      })
      .catch((err) => {
        console.warn("[mf] platform limits unavailable, keeping current:", err.message);
        cache = { ...cache, at: Date.now() };
        return cache.limits;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Synchronous read of whatever is cached — never triggers a fetch. */
const peekLimits = () => cache.limits;

/**
 * QA 6.2 — raise a scheme's own minimums to the platform floor, in place.
 *
 * The floor was enforced in the order path and nowhere else, so the fund page went on
 * advertising BSE's ₹1,000 while an admin's ₹25,000 was what actually applied. An investor
 * typed the amount the page asked for and was refused. Display and enforcement have to be
 * the same number or one of them is lying.
 *
 * Only the two paths the order code actually refuses on — lumpsum purchase and SIP
 * instalment — which are also the only two the admin can set. Redemption, switch and
 * SWP/STP are untouched: a floor on money going IN says nothing about money coming out.
 *
 * A floor of 0 means "no house rule today" and leaves `null` as `null`, so "BSE did not
 * say" still renders as nothing rather than as an invented minimum.
 */
function applyFloor(limits = NONE, mapped = null, transactions = null) {
  const raise = (own, floor) => {
    const f = Number(floor) || 0;
    if (!f) return own;
    const o = Number(own);
    return Number.isFinite(o) && o > 0 ? Math.max(o, f) : f;
  };

  if (mapped) {
    mapped.minLumpsum = raise(mapped.minLumpsum, limits.minLumpsum);
    mapped.minSip = raise(mapped.minSip, limits.minSip);
  }

  if (transactions?.lumpsum) {
    transactions.lumpsum.minAmount = raise(transactions.lumpsum.minAmount, limits.minLumpsum);
  }

  if (transactions?.sip) {
    transactions.sip.minAmount = raise(transactions.sip.minAmount, limits.minSip);
    // Each frequency carries its own minimum and the SIP form reads the one it picked.
    for (const freq of transactions.sip.frequencies || []) {
      freq.minAmount = raise(freq.minAmount, limits.minSip);
    }
  }

  return { mapped, transactions };
}

module.exports = { getLimits, peekLimits, applyFloor, NONE };
