const axios = require("axios");
const { configData } = require("../config");

/**
 * Ticket 5 — Fund Portfolio and Top Holdings.
 *
 * What a scheme owns is disclosed monthly by the AMC. Nothing this platform reads carries
 * it: BSE's scheme master has no such column and no endpoint for one (ten candidates
 * probed, all 404), the enrichment feed publishes none, and AMFI puts out per-AMC PDFs
 * rather than data. So the source is the admin panel — an admin uploads the disclosure and
 * Laravel serves it here, the same way `hidden.js` reads the catalogue blocklist.
 *
 * Fail-open, like the rest of the fund page: a scheme with no uploaded portfolio, or an
 * unreachable Laravel, means the holdings section is absent. It never means an empty table
 * under a heading, and it certainly never means invented rows — the whole reason this data
 * went missing in the first place was that the old code fabricated it.
 */

const url = () => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "/scheme-holdings");

const TTL_MS = 30 * 60 * 1000; // A portfolio changes monthly; half an hour is generous.
const MISS_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

const cache = new Map();
const inFlight = new Map();

const EMPTY = Object.freeze({ holdings: [], assetSplit: [], sectors: [], asOf: null });

const keyOf = (isin, code) => `${String(isin || "").trim().toUpperCase()}|${String(code || "").trim().toUpperCase()}`;

/** Newest-wins eviction, so a long-running process cannot grow this without bound. */
function remember(key, value, ttl) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { value, exp: Date.now() + ttl });
}

function shape(data) {
  if (!data || !Array.isArray(data.holdings) || !data.holdings.length) return EMPTY;

  return {
    asOf: data.as_of || null,
    holdings: data.holdings.map((h) => ({
      name: h.name,
      sector: h.sector || null,
      instrument: h.instrument || null,
      pct: Number(h.pct) || 0,
      value: h.value == null ? null : Number(h.value),
    })),
    // The donuts are drawn only from a column the file actually had — an "Unclassified"
    // single slice is not an asset allocation.
    assetSplit: Array.isArray(data.asset_split) ? data.asset_split : [],
    sectors: Array.isArray(data.sectors) ? data.sectors : [],
  };
}

/**
 * The scheme's latest disclosed portfolio, or EMPTY. Never throws.
 */
async function getHoldings(isin, code) {
  const key = keyOf(isin, code);
  if (key === "|") return EMPTY;

  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.value;

  if (inFlight.has(key)) return inFlight.get(key);

  const job = axios
    .get(url(), { params: { isin: isin || "", code: code || "" }, timeout: 8000 })
    .then((res) => {
      const value = shape(res?.data?.data);
      remember(key, value, value === EMPTY ? MISS_TTL_MS : TTL_MS);
      return value;
    })
    .catch((err) => {
      console.warn("[mf] scheme holdings unavailable:", err.message);
      remember(key, EMPTY, MISS_TTL_MS);
      return EMPTY;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

const resetHoldingsCache = () => {
  cache.clear();
  inFlight.clear();
};

module.exports = { getHoldings, resetHoldingsCache, shape, EMPTY };
