const axios = require("axios");

// AMFI publishes every live scheme's NAV daily, keyed by ISIN — the same ISINs BSE
// uses. One 1.5 MB text file covers what the BSE demo snapshot cannot.
// ponytail: portal.amfiindia.com only — www.amfiindia.com times out from AWS.
const URL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache = { at: 0, navs: {}, schemes: [], codes: {} };
let inflight = null;

const LINE_BREAK = /\r?\n/;

/**
 * Semicolon-separated, with a header row and blank/section separator lines.
 * AMFI has shipped both a 6-column and an 8-column layout, so read NAV and date
 * from the last two fields and the ISINs from fields 1-2 rather than fixed indexes.
 */
function parseNavAll(text = "") {
  const navs = {};
  for (const line of String(text).split(LINE_BREAK)) {
    if (!line.includes(";")) continue;
    const f = line.split(";");
    if (f.length < 5 || f[0].trim() === "Scheme Code") continue;
    const nav = Number(f[f.length - 2]);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    const date = f[f.length - 1].trim() || null;
    for (const raw of [f[1], f[2]]) {
      const isin = String(raw || "").trim().toUpperCase();
      if (isin && isin !== "-") navs[isin] = { nav, date };
    }
  }
  return navs;
}

/**
 * Same file, third view: {ISIN: AMFI scheme code}, read from column 0.
 *
 * This is the registry that makes real NAV history possible. mfapi.in is keyed by exactly
 * this code, so an ISIN we already hold turns into the full published NAV series with no
 * guessing. The name search it replaces missed whenever BSE and AMFI word a scheme
 * differently — BSE says "… REGULAR IDCW PAYOUT", AMFI says "… Regular Plan - IDCW", and
 * mfapi's AND-match on the word "PAYOUT" returned nothing, so the fund silently fell back
 * to a fabricated straight line.
 */
function parseNavCodes(text = "") {
  const codes = {};
  for (const line of String(text).split(LINE_BREAK)) {
    if (!line.includes(";")) continue;
    const f = line.split(";");
    if (f.length < 5) continue;
    const code = String(f[0] || "").trim();
    if (!/^\d+$/.test(code)) continue; // also skips the "Scheme Code" header row
    for (const raw of [f[1], f[2]]) {
      const isin = String(raw || "").trim().toUpperCase();
      if (isin && isin !== "-") codes[isin] = code;
    }
  }
  return codes;
}

/**
 * Same file, second view: the rows themselves, not just the ISIN→NAV map. Only used as a
 * catalogue fallback when BSE is unreachable — a dev machine is not IP-whitelisted to the
 * demo host, so without this the fund list is empty locally.
 *
 * ponytail: section headers carry no ";" — a line mentioning "Scheme" is the category
 * banner, anything else is the AMC name. True of today's NAVAll.txt; if AMFI renames its
 * banners only category/AMC mislabel, name and NAV stay correct.
 */
function parseNavSchemes(text = "") {
  const out = [];
  let amc = "";
  let category = "";

  for (const line of String(text).split(LINE_BREAK)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!line.includes(";")) {
      if (/scheme/i.test(trimmed)) category = trimmed;
      else amc = trimmed;
      continue;
    }

    const f = line.split(";");
    if (f.length < 5 || f[0].trim() === "Scheme Code") continue;
    const nav = Number(f[f.length - 2]);
    if (!Number.isFinite(nav) || nav <= 0) continue;

    const isin = [f[1], f[2]]
      .map((v) => String(v || "").trim().toUpperCase())
      .find((v) => v && v !== "-");
    if (!isin) continue;

    const wide = f.length >= 8;
    out.push({
      scheme_name: String(f[3] || "").trim(),
      scheme_isin: isin,
      scheme_bse_code: String(f[0] || "").trim(),
      nav,
      nav_date: f[f.length - 1].trim() || null,
      scheme_amc_name: amc,
      scheme_category: category,
      scheme_plan: wide ? String(f[4] || "").trim() : null,
      scheme_option: wide ? String(f[5] || "").trim() : null,
    });
  }

  return out;
}

async function getAmfiNavs() {
  if (Date.now() - cache.at < TTL_MS) return cache;
  if (!inflight) {
    inflight = axios
      .get(URL, { timeout: 30000, responseType: "text" })
      .then(({ data }) => {
        const navs = parseNavAll(data);
        if (Object.keys(navs).length) {
          cache = { at: Date.now(), navs, schemes: parseNavSchemes(data), codes: parseNavCodes(data) };
        }
        return cache;
      })
      .catch((err) => {
        console.error("[amfi-nav]", err.message);
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** AMFI scheme code for an ISIN, or null. Never throws — a miss just means the caller
 *  falls back to searching by name. */
async function amfiCodeForIsin(isin) {
  const key = String(isin || "").trim().toUpperCase();
  if (!key) return null;
  try {
    return (await getAmfiNavs()).codes?.[key] || null;
  } catch {
    return null;
  }
}

module.exports = { getAmfiNavs, amfiCodeForIsin, parseNavAll, parseNavSchemes, parseNavCodes };
