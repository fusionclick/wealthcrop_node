// Shared NAV map keyed by ISIN and BSE scheme code, merged from two sources:
//   AMFI  — every live scheme, refreshed daily, the industry source of record.
//   BSE   — nav_master_list, used only to fill gaps AMFI does not cover.
// The BSE demo set is a frozen snapshot (~7.4k rows, newest nav_date months old) and
// returns nothing for any nav_date filter, so we pull it unfiltered and keep the
// newest NAV per scheme. Prod behaves the same, just with current dates.
// ponytail: single process-wide map, add redis if this ever runs multi-instance.
const { getAmfiNavs } = require("./amfiNav");

const TTL_MS = 10 * 60 * 1000;

let latest = { at: 0, loaded: false, date: null, navs: {} };
let inflight = null;

const key = (v) => String(v || "").trim().toUpperCase();
const dateMs = (v) => Date.parse(String(v || "").replace(/-/g, " "));

/** {ISIN|BSE_CODE: {nav, date}} keeping the newest nav_date when a scheme repeats. */
function mapNavRows(lists = []) {
  const navs = {};
  for (const row of lists) {
    const nav = Number(row.nav ?? row.nav_value);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    const date = row.nav_date || null;
    const ms = dateMs(date);
    for (const k of [key(row.isin || row.scheme_isin), key(row.bse_scheme_code || row.scheme_bse_code)]) {
      if (!k) continue;
      const prev = navs[k];
      if (prev && !(ms > dateMs(prev.date))) continue;
      navs[k] = { nav, date };
    }
  }
  return navs;
}

async function fetchAll(controller) {
  const reqObj = {
    data: { fields: ["ALL"], count_only: false, start: 0, length: 20000, filter_param: {} },
  };
  try {
    return await controller.navService.getNavMasterList(controller.accessToken, reqObj);
  } catch (err) {
    if (!String(err.message || "").includes("401")) throw err;
    controller.accessToken = null;
    await controller.loginFunc();
    return controller.navService.getNavMasterList(controller.accessToken, reqObj);
  }
}

async function refresh(controller) {
  // AMFI first: it publishes every live scheme daily and is the industry source of
  // record. BSE only fills gaps — its demo snapshot is months stale.
  const amfi = (await getAmfiNavs()).navs;

  let rows = [];
  try {
    if (!controller.accessToken) await controller.loginFunc();
    if (controller.accessToken) rows = (await fetchAll(controller))?.data?.lists || [];
  } catch (err) {
    console.error("[nav-store] bse", err.message);
  }
  const navs = { ...mapNavRows(rows), ...amfi };
  if (!Object.keys(navs).length) return latest;
  // seeded with null, so compare via `!(ms <= best)` — `ms > NaN` is always false.
  const newest = Object.values(navs).reduce((best, v) => {
    const ms = dateMs(v.date);
    return Number.isFinite(ms) && !(ms <= dateMs(best)) ? v.date : best;
  }, null);
  latest = { at: Date.now(), loaded: true, date: newest, navs };
  return latest;
}

/** Latest NAV map, refreshed at most once per TTL. Never throws. */
async function getNavs(controller) {
  if (Date.now() - latest.at < TTL_MS) return latest;
  if (!inflight) {
    inflight = refresh(controller)
      .catch((err) => {
        console.error("[nav-store]", err.message);
        return latest;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

const entry = (navs = {}, isin, code) => navs[key(isin)] || navs[key(code)] || null;
const navFor = (navs, isin, code) => entry(navs, isin, code)?.nav ?? null;
const navDateFor = (navs, isin, code) => entry(navs, isin, code)?.date ?? null;

module.exports = { getNavs, refresh, navFor, navDateFor, mapNavRows };
