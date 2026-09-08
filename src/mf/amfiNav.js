const axios = require("axios");

// AMFI publishes every live scheme's NAV daily, keyed by ISIN — the same ISINs BSE
// uses. One 1.5 MB text file covers what the BSE demo snapshot cannot.
// ponytail: portal.amfiindia.com only — www.amfiindia.com times out from AWS.
const URL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache = { at: 0, navs: {}, schemes: [] };
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
          cache = { at: Date.now(), navs, schemes: parseNavSchemes(data) };
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

module.exports = { getAmfiNavs, parseNavAll, parseNavSchemes };
