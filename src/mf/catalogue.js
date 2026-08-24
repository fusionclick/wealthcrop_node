const { mapScheme, isTransactable, matchesCategory } = require("./scheme");
const { getNavs, navFor, navDateFor } = require("./navStore");

// The full BSE scheme master, fetched once per TTL and priced from the NAV store.
//
// Schemes with no NAV in AMFI *or* BSE are matured/wound-up (fixed-term plans,
// FMP series, closed gilt PF plans) — roughly 45% of the 28k rows. They cannot be
// bought and have no price, so they are dropped rather than shown as blank cards.
// BSE demo returns null for scheme_status/purchase_allowed, so isTransactable()
// alone filters nothing; having a NAV is the only reliable liveness signal here.
//
// ponytail: whole catalogue in memory (~15k rows). Fine for one box; page against
// a real datastore if this ever needs multi-instance consistency.
const TTL_MS = 30 * 60 * 1000;
const FETCH_PAGE = 5000;
const MAX_ROWS = 40000;

let cache = { at: 0, list: [], total: 0, unpriced: 0 };
let inflight = null;

async function fetchPage(controller, start, length) {
  const reqObj = {
    data: { start, length, fields: ["ALL"], count_only: false, filter_param: {}, search: {} },
  };
  try {
    return await controller.masterDataService.getSchemeMasterList(controller.accessToken, reqObj);
  } catch (err) {
    if (!String(err.message || "").includes("401")) throw err;
    controller.accessToken = null;
    await controller.loginFunc();
    return controller.masterDataService.getSchemeMasterList(controller.accessToken, reqObj);
  }
}

async function build(controller) {
  if (!controller.accessToken) await controller.loginFunc();
  if (!controller.accessToken) return cache;

  // Advance by the rows actually returned, not the rows requested: BSE may cap a
  // page below FETCH_PAGE, and assuming otherwise silently truncates the catalogue.
  const raw = [];
  let total = Infinity;
  let start = 0;
  while (start < Math.min(total, MAX_ROWS)) {
    const res = await fetchPage(controller, start, FETCH_PAGE);
    const rows = res?.data?.lists || [];
    if (Number.isFinite(Number(res?.data?.count))) total = Number(res.data.count);
    if (!rows.length) break;
    raw.push(...rows);
    start += rows.length;
  }
  if (!raw.length) return cache;

  const { navs } = await getNavs(controller);
  const list = [];
  let unpriced = 0;
  raw.filter(isTransactable).forEach((row, i) => {
    const item = mapScheme(row, i);
    const nav = item.nav ?? navFor(navs, item.scheme_isin, item.scheme_bse_code);
    if (nav == null) {
      unpriced++;
      return;
    }
    item.nav = nav;
    item.nav_date = navDateFor(navs, item.scheme_isin, item.scheme_bse_code);
    item.nav_loaded = true;
    list.push(item);
  });

  cache = { at: Date.now(), list, total: raw.length, unpriced };
  console.log(`[catalogue] ${list.length} priced of ${raw.length} schemes (${unpriced} unpriced dropped)`);
  return cache;
}

/** Cached catalogue; never throws, falls back to the previous snapshot. */
async function getCatalogue(controller) {
  if (Date.now() - cache.at < TTL_MS && cache.list.length) return cache;
  if (!inflight) {
    inflight = build(controller)
      .catch((err) => {
        console.error("[catalogue]", err.message);
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

const haystack = (f) => `${f.name || ""} ${f.scheme_isin || ""} ${f.scheme_bse_code || ""} ${f.scheme_amc_name || ""}`.toLowerCase();

/** Exact in-memory search + category filter + pagination. */
function query(list = [], { search = "", category = "", isin = "", scheme_code = "", start = 0, length = 20 } = {}) {
  let rows = list;
  const code = String(isin || scheme_code || "").trim().toUpperCase();
  if (code) {
    rows = rows.filter(
      (f) =>
        String(f.scheme_isin || "").toUpperCase() === code ||
        String(f.scheme_bse_code || "").toUpperCase() === code
    );
  }
  if (category) rows = rows.filter((f) => matchesCategory(f, category));
  const q = String(search || "").trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    rows = rows.filter((f) => {
      const hay = haystack(f);
      return terms.every((t) => hay.includes(t));
    });
  }
  return { total: rows.length, lists: rows.slice(start, start + length) };
}

module.exports = { getCatalogue, query };
