const axios = require("axios");
const { configData } = require("../config");

// Laravel owns the classification (admin panel -> Fund Catalogue); Node has no database of
// its own, so it reads the map over the same host it already uses for investor-data — the
// same shape as hidden.js.
const url = () => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "/scheme-categories");

const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, byCode: new Map(), byIsin: new Map() };
let inFlight = null;

const upper = (v) => String(v || "").trim().toUpperCase();

const toMap = (obj) =>
  new Map(Object.entries(obj || {}).map(([k, v]) => [upper(k), String(v || "")]).filter(([k, v]) => k && v));

async function load() {
  const res = await axios.get(url(), { timeout: 8000 });
  const data = res?.data?.data || {};
  return {
    at: Date.now(),
    byCode: toMap(data.by_scheme_bse_code),
    byIsin: toMap(data.by_scheme_isin),
  };
}

/**
 * ponytail: fail-open, same as hidden.js. Laravel down hone par catalogue chalta rahe —
 * category ek label hai, gate nahi. Purani cache rakh li jaati hai.
 */
async function getCategories() {
  if (Date.now() - cache.at < TTL_MS) return cache;
  if (!inFlight) {
    inFlight = load()
      .then((fresh) => {
        cache = fresh;
        return cache;
      })
      .catch((err) => {
        console.warn("[mf] scheme-category map unavailable:", err.message);
        cache = { ...cache, at: Date.now() };
        return cache;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const categoryOf = (map, item = {}) =>
  map.byCode.get(upper(item.scheme_bse_code)) || map.byIsin.get(upper(item.scheme_isin)) || null;

function resetCategoryCache(seed = null) {
  cache = seed
    ? { at: Date.now(), byCode: toMap(seed.by_scheme_bse_code), byIsin: toMap(seed.by_scheme_isin) }
    : { at: 0, byCode: new Map(), byIsin: new Map() };
}

module.exports = { getCategories, categoryOf, resetCategoryCache };
