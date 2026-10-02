const axios = require("axios");
const { configData } = require("../config");

/**
 * Audit #11 — "Invest in this basket": one lump sum, split by the basket's own weights, placed
 * as one purchase per fund through the same /purchaseNewOrder gates as any single order.
 *
 * The split is computed here from the weights Laravel stores, never taken from the browser —
 * the same rule SpreadController follows: a page that can name its own per-fund amounts can
 * send legs that add up to more than the investor agreed to.
 */

/**
 * Split `total` rupees by `weights`, exactly to the paisa. Largest remainder, like
 * utils/spread.js and SpreadController::splitByPercent: rounding each share on its own loses
 * or invents money. Weights are normalised by their own sum (Laravel accepts 100 ± 0.01).
 */
function splitByWeight(total, weights = []) {
  const paise = Math.round(Number(total) * 100);
  const sum = weights.reduce((s, w) => s + (Number(w) || 0), 0);
  if (!weights.length || !(paise > 0) || !(sum > 0)) return weights.map(() => 0);

  const exact = weights.map((w) => (paise * (Number(w) || 0)) / sum);
  const out = exact.map(Math.floor);
  let left = paise - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) out[order[k].i] += 1;
  return out.map((p) => p / 100);
}

/**
 * The basket as Laravel holds it, for the caller only: { name, legs: [{code, name, asset_type,
 * weight}] }. null when it is not theirs, does not exist, or Laravel cannot be reached — a
 * checkout must never run against a basket it could not read.
 */
async function basketPlan(req, id) {
  const base = String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "");
  try {
    const res = await axios.get(`${base}/baskets/${encodeURIComponent(id)}/checkout`, {
      timeout: 15000,
      headers: {
        authorization: req.headers?.authorization,
        "user-agent": req.headers?.["user-agent"] || "",
        accept: "application/json",
      },
    });
    const data = res?.data?.data;
    return data && Array.isArray(data.legs) ? data : null;
  } catch (err) {
    console.warn("[basket] plan unavailable:", err.response?.status || err.message);
    return null;
  }
}

module.exports = { splitByWeight, basketPlan };
