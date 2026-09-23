const axios = require("axios");
const { configData } = require("../config");

/**
 * AMFI §1.A/§1.B — the distributor identity (ARN) and the commission-structure link.
 *
 * Read from the admin panel rather than from this process's env. The ARN belongs to the
 * business: whoever holds it should be able to correct it without an SSH session and a
 * container restart, and one value has to be identical on the footer, the commission page
 * and the `sub_br_arn` of every BSE payload. Env stays as the fallback for an install that
 * has not opened the settings page.
 *
 * ── Fails to the SAFE side, which here is "say nothing" ──────────────────────────────────
 * hidden.js fails open because hiding the whole catalogue is worse than showing one fund
 * that should be hidden. This is the opposite: an ARN we cannot confirm must not be printed,
 * because a wrong or stale registration number on a live screen is a misrepresentation. So
 * an outage keeps the LAST GOOD value (which was confirmed once) and never invents one.
 */

const url = () => `${String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "")}/distributor`;

const TTL_MS = 5 * 60 * 1000;

// Env is the seed, not the authority: whatever the admin panel says wins the moment it
// answers once.
const FALLBACK = {
  legal_entity: process.env.LEGAL_ENTITY_NAME || "Wealthcrop Advisory Pvt Ltd",
  arn: String(process.env.DISTRIBUTOR_ARN || "").trim().toUpperCase(),
  sub_br_code: String(process.env.DISTRIBUTOR_SUB_BROKER_CODE || "").trim(),
  commission_url: String(process.env.COMMISSION_STRUCTURE_URL || "").trim(),
  commission_version: String(process.env.COMMISSION_STRUCTURE_VERSION || "").trim(),
};
FALLBACK.line = FALLBACK.arn
  ? `${FALLBACK.legal_entity} | AMFI-registered Mutual Fund Distributor | ARN: ${FALLBACK.arn}`
  : "";

let cache = { at: 0, value: FALLBACK };
let inFlight = null;

async function load() {
  const res = await axios.get(url(), { timeout: 8000 });
  const d = res?.data?.data || {};
  const arn = String(d.arn || "").trim().toUpperCase();
  const entity = String(d.legal_entity || FALLBACK.legal_entity).trim();
  return {
    at: Date.now(),
    value: {
      legal_entity: entity,
      arn,
      sub_br_code: String(d.sub_br_code || "").trim(),
      // Built here rather than trusted from the wire, so a half-filled settings row cannot
      // produce "… | ARN: " on every screen.
      line: arn ? `${entity} | AMFI-registered Mutual Fund Distributor | ARN: ${arn}` : "",
      commission_url: String(d.commission_url || "").trim(),
      commission_version: String(d.commission_version || "").trim(),
    },
  };
}

async function getDistributor() {
  if (Date.now() - cache.at < TTL_MS) return cache.value;
  if (!inFlight) {
    inFlight = load()
      .then((fresh) => {
        cache = fresh;
        return cache.value;
      })
      .catch((err) => {
        console.warn("[compliance] distributor settings unavailable, keeping last good:", err.message);
        cache = { ...cache, at: Date.now() };
        return cache.value;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Synchronous read for the order path, which cannot await on every payload. */
const cachedDistributor = () => cache.value;

module.exports = { getDistributor, cachedDistributor };
