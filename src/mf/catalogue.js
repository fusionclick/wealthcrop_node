const { mapScheme, isTransactable, matchesCategory, categorySearch } = require("./scheme");
const { getAmfiNavs } = require("./amfiNav");
const { navFor, navDateFor } = require("./navStore");
const { getHidden, isHidden } = require("./hidden");

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

// BSE demo host is IP-whitelisted to the EC2 box, so a dev machine gets a 21s timeout and
// an empty fund list. With this on, AMFI's public NAVAll.txt stands in for the catalogue.
// OFF by default: AMFI rows carry no purchase/SIP flags, so orders would fail at BSE anyway
// — this is for browsing the UI locally, not a production degradation path.
const AMFI_FALLBACK = process.env.MF_AMFI_FALLBACK === "1";

async function amfiCatalogue(q) {
  const schemes = (await getAmfiNavs()).schemes || [];
  if (!schemes.length) return { list: [], total: 0, unpriced: 0 };

  const all = schemes.map((row, i) => {
    const item = mapScheme(row, i);
    item.nav_loaded = item.nav != null;
    item.source = "amfi";
    return item;
  });

  const hidden = await getHidden();
  const { total, lists } = query(all.filter((item) => !isHidden(hidden, item)), q);
  console.warn(`[mf] BSE unreachable — serving ${lists.length}/${total} schemes from AMFI (MF_AMFI_FALLBACK=1)`);
  return { list: lists, total, unpriced: 0, fields: Object.keys(schemes[0]), sample: null, source: "amfi" };
}

async function getCatalogue(controller, q = {}) {
  if (!controller.accessToken) {
    const login = await controller.loginFunc();
    // ponytail: login ki wajah warna gum ho jati thi aur upar sirf 502 dikhta tha
    if (login?.status === 'error') console.error('[BSE] login failed:', login.message);
  }
  if (!controller.accessToken) {
    return AMFI_FALLBACK ? amfiCatalogue(q) : { list: [], total: 0, unpriced: 0 };
  }

  const start = Number(q.start) || 0;
  const length = Math.min(FETCH_MAX, Math.max(1, Number(q.length) || 20));
  const search = String(q.search || q.isin || q.scheme_code || categorySearch(q.category) || "").trim();
  const fetchLen = Math.min(FETCH_MAX, Math.max(length, length * 2));

  let res;
  try {
    res = await fetchPage(controller, start, fetchLen, search);
  } catch (err) {
    // Login can succeed off cached creds and still time out on the page fetch.
    if (!AMFI_FALLBACK) throw err;
    console.warn("[mf] BSE page fetch failed:", err.message);
    return amfiCatalogue(q);
  }
  const rows = res?.data?.lists || [];
  const amfi = (await getAmfiNavs()).navs;
  const hidden = await getHidden();
  const list = [];
  let unpriced = 0;
  // ponytail: physical-only schemes ab list mein rehti hain aur `physical_only` par
  // badge dikhta hai — chhupane se investor ko pata hi nahi chalta ke fund mojood hai.
  // Order phir bhi nahi ja sakta (UCC demat par hai, BSE msgid 1020 phys_ucc deta hai);
  // rok MutualFundInvestPage ke `dematBlocked` par hai, list par nahi.
  rows.filter(isTransactable).forEach((row, i) => {
    const item = mapScheme(row, i);
    // Admin ne is scheme ko chhupaya hai — list se bahar, aur unpriced bhi nahi ginti.
    if (isHidden(hidden, item)) return;
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

// YES/NO filters BSE ke apne per-scheme flags par lagte hain: `sip_allowed` (systematic[]
// ka sip_flag) aur `holding_modes` (lumpsum[] ka demat/physical). null ka matlab "BSE ne
// bataya hi nahi" — usay "no" mat ginna, warna filter aadhi list kha jata hai.
const YESNO = { yes: true, y: true, "1": true, no: false, n: false, "0": false };

function query(list = [], { search = "", category = "", isin = "", scheme_code = "", plan = "", sip = "", mode = "", start = 0, length = 20 } = {}) {
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
  if (plan) rows = rows.filter((f) => String(f.plan || "").toLowerCase() === plan);
  if (sip in YESNO) rows = rows.filter((f) => f.sip_allowed === YESNO[sip]);
  if (mode === "physical") rows = rows.filter((f) => f.holding_modes?.physical === true);
  if (mode === "demat") rows = rows.filter((f) => f.holding_modes?.demat !== false);
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

module.exports = { getCatalogue, query, AMFI_FALLBACK };
