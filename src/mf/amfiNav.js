const axios = require("axios");

// AMFI publishes every live scheme's NAV daily, keyed by ISIN — the same ISINs BSE
// uses. One 1.5 MB text file covers what the BSE demo snapshot cannot.
// ponytail: portal.amfiindia.com only — www.amfiindia.com times out from AWS.
const URL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache = { at: 0, navs: {} };
let inflight = null;

/**
 * Semicolon-separated, with a header row and blank/section separator lines.
 * AMFI has shipped both a 6-column and an 8-column layout, so read NAV and date
 * from the last two fields and the ISINs from fields 1-2 rather than fixed indexes.
 */
function parseNavAll(text = "") {
  const navs = {};
  for (const line of String(text).split(/\r?\n/)) {
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

async function getAmfiNavs() {
  if (Date.now() - cache.at < TTL_MS) return cache;
  if (!inflight) {
    inflight = axios
      .get(URL, { timeout: 30000, responseType: "text" })
      .then(({ data }) => {
        const navs = parseNavAll(data);
        if (Object.keys(navs).length) cache = { at: Date.now(), navs };
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

module.exports = { getAmfiNavs, parseNavAll };
