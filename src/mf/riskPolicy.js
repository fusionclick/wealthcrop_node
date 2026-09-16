const axios = require("axios");
const { configData } = require("../config");

/**
 * Ticket 23 — "Risk calculation rules must be configurable according to the approved
 * business rules."
 *
 * The ceilings used to be a constant in suitability.js, which meant compliance changing a
 * band by memo required a deploy. Laravel owns them now (admin panel → Settings → Risk
 * Policy) and Node reads them here, exactly the way `hidden.js` reads the catalogue
 * blocklist: same host, short TTL, one in-flight request.
 *
 * ── Why this one does NOT fail open ──────────────────────────────────────────────────────
 * `hidden.js` fails open because hiding the whole catalogue is worse than showing a fund
 * that should be hidden. This is the opposite kind of switch: it decides whether an order is
 * suitable. So when Laravel is unreachable the LAST GOOD policy stands, and if there has
 * never been one, DEFAULTS below — which are the conservative ceilings this platform already
 * shipped. There is no state in which an outage widens what an investor is allowed to buy.
 */

const url = () => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "/risk-policy");

const TTL_MS = 5 * 60 * 1000;

// Ranks are SEBI's six riskometer levels, 1 = Low … 6 = Very High.
const DEFAULTS = Object.freeze({
  conservative: 3, // up to Moderate
  moderate: 4, // up to Moderately High
  aggressive: 6, // up to Very High
});

let cache = { at: 0, policy: { ...DEFAULTS } };
let inFlight = null;

/** A ceiling outside 1..6 is not a stricter rule, it is a typo — fall back to the default. */
const ceiling = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : fallback;
};

function normalise(raw = {}) {
  return {
    conservative: ceiling(raw.conservative, DEFAULTS.conservative),
    moderate: ceiling(raw.moderate, DEFAULTS.moderate),
    aggressive: ceiling(raw.aggressive, DEFAULTS.aggressive),
  };
}

async function load() {
  const res = await axios.get(url(), { timeout: 8000 });
  return { at: Date.now(), policy: normalise(res?.data?.data || {}) };
}

async function getRiskPolicy() {
  if (Date.now() - cache.at < TTL_MS) return cache.policy;
  if (!inFlight) {
    inFlight = load()
      .then((fresh) => {
        cache = fresh;
        return cache.policy;
      })
      .catch((err) => {
        // Keep the last good policy and stop hammering a host that is down.
        console.warn("[mf] risk policy unavailable, keeping current:", err.message);
        cache = { ...cache, at: Date.now() };
        return cache.policy;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Synchronous read of whatever is currently cached — never triggers a fetch. */
const peekRiskPolicy = () => cache.policy;

module.exports = { getRiskPolicy, peekRiskPolicy, normalise, DEFAULTS };
