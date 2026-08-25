const { mapScheme, isTransactable, allowedModes, matchesCategory, categorySearch } = require("./scheme");
const { getAmfiNavs } = require("./amfiNav");
const { navFor, navDateFor } = require("./navStore");

// One BSE page per request. Loading the full master (~28k) + BSE nav dump OOMs
// the 1GB EC2 and nginx returns 502. AMFI prices the page; search goes to BSE.
const FETCH_MAX = 100;

async function fetchPage(controller, start, length, search) {
  const reqObj = {
    data: {
      start,
      length,
      fields: ["ALL"],
      count_only: false,
      filter_param: {},
      search: search ? { value: search } : {},
    },
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

async function getCatalogue(controller, q = {}) {
  if (!controller.accessToken) {
    const login = await controller.loginFunc();
    // ponytail: login ki wajah warna gum ho jati thi aur upar sirf 502 dikhta tha
    if (login?.status === 'error') console.error('[BSE] login failed:', login.message);
  }
  if (!controller.accessToken) return { list: [], total: 0, unpriced: 0 };

  const start = Number(q.start) || 0;
  const length = Math.min(FETCH_MAX, Math.max(1, Number(q.length) || 20));
  const search = String(q.search || q.isin || q.scheme_code || categorySearch(q.category) || "").trim();
  const fetchLen = Math.min(FETCH_MAX, Math.max(length, length * 2));

  const res = await fetchPage(controller, start, fetchLen, search);
  const rows = res?.data?.lists || [];
  const amfi = (await getAmfiNavs()).navs;
  const list = [];
  let unpriced = 0;
  // ponytail: add_ucc har UCC demat par banata hai (is_client_physical false), is liye
  // physical-only scheme khareedi hi nahi ja sakti — BSE msgid 1020 phys_ucc deta hai.
  // List se bahar. UCC kabhi "both" par bane to ye filter hata dena.
  const buyable = (row) => allowedModes(row)?.demat !== false;
  rows.filter(isTransactable).filter(buyable).forEach((row, i) => {
    const item = mapScheme(row, i);
    const nav = item.nav ?? navFor(amfi, item.scheme_isin, item.scheme_bse_code);
    if (nav == null) {
      unpriced++;
      return;
    }
    item.nav = nav;
    item.nav_date = item.nav_date || navDateFor(amfi, item.scheme_isin, item.scheme_bse_code);
    item.nav_loaded = true;
    list.push(item);
  });

  const total = Number(res?.data?.count);
  return {
    list: list.slice(0, length),
    total: Number.isFinite(total) ? total : list.length,
    unpriced,
    // ponytail: BSE ke row mein asli field kaunse hain — mapScheme jo naam dhoondta hai
    // wo mil bhi rahe hain ya nahi, ye batata hai. `isTransactable` chup chaap sach maan
    // leta hai jab flag na mile, is liye ye dikhna zaroori hai.
    fields: Object.keys(rows[0] || {}),
    // ponytail: sirf single-scheme lookup par ek raw row — is se pata chalta hai BSE
    // ne kya bheja jab koi scheme order par reject hoti hai. Filter pakka hote hi hata dena.
    sample: (q.scheme_code || q.isin) && rows[0] ? rows[0] : null,
  };
}

const haystack = (f) => `${f.name || ""} ${f.scheme_isin || ""} ${f.scheme_bse_code || ""} ${f.scheme_amc_name || ""}`.toLowerCase();

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
