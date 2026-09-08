const axios = require("axios");
const { configData } = require("../config");

// Laravel owns the blocklist (admin panel -> Fund Catalogue); Node has no database of its
// own, so it reads the list over the same host it already uses for investor-data.
const url = () => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "/hidden-schemes");

const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, codes: new Set(), isins: new Set() };
let inFlight = null;

const upper = (v) => String(v || "").trim().toUpperCase();

async function load() {
  const res = await axios.get(url(), { timeout: 8000 });
  const data = res?.data?.data || {};
  return {
    at: Date.now(),
    codes: new Set((data.codes || []).map(upper).filter(Boolean)),
    isins: new Set((data.isins || []).map(upper).filter(Boolean)),
  };
}

/**
 * ponytail: fail-open. Laravel down par poora catalogue chhupa dena us se kahin bura hai
 * jo ye rok raha hai — investor ko khali fund list milti. Purani cache rakh li jaati hai.
 */
async function getHidden() {
  if (Date.now() - cache.at < TTL_MS) return cache;
  if (!inFlight) {
    inFlight = load()
      .then((fresh) => {
        cache = fresh;
        return cache;
      })
      .catch((err) => {
        console.warn("[mf] hidden-scheme list unavailable:", err.message);
        cache = { ...cache, at: Date.now() };
        return cache;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const isHidden = (hidden, item = {}) =>
  hidden.codes.has(upper(item.scheme_bse_code)) || hidden.isins.has(upper(item.scheme_isin));

function resetHiddenCache(seed = null) {
  cache = seed
    ? { at: Date.now(), codes: new Set(seed.codes || []), isins: new Set(seed.isins || []) }
    : { at: 0, codes: new Set(), isins: new Set() };
}

module.exports = { getHidden, isHidden, resetHiddenCache };
