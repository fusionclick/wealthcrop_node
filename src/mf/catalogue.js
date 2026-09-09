const { mapScheme, isTransactable, matchesCategory } = require("./scheme");
const { getAmfiNavs } = require("./amfiNav");
const { navFor, navDateFor } = require("./navStore");
const { getHidden, isHidden } = require("./hidden");
const { getCategories, categoryOf } = require("./categories");

// Page size the caller may ask for. BSE ka master khud chunk-chunk aata hai (CHUNK).
const FETCH_MAX = 100;

// ponytail: `search` ab BSE ko nahi bheja jata — poora master yahan cached hai, is liye
// search/category filter `query()` mein locally chalta hai aur uska `total` bhi sach
// hota hai. Khali `search: {}` key rehne di hai: yehi wo proven shape hai jis par BSE
// `invalid_json` nahi deta (dekho buildXspListPayload ka note StarMFController mein).
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
  return { list: lists, total, unpriced: 0, priced: all.length, fetched: all.length, fields: Object.keys(schemes[0]), sample: null, source: "amfi" };
}

// Ek page par filter lagana jhoot tha: "Regular" chuno to 20 rows mein se 3 bachti thin
// aur pagination phir bhi 1400 pages dikhata tha. Filter poore catalogue par chalna
// chahiye, is liye BSE ka master ek baar chunk-chunk kar ke mapped rows mein badalta hai
// aur yahin process-wide baith jata hai — wahi shakal jo navStore/amfiNav ki hai.
//
// ponytail: har chunk ka RAW row map hote hi chhod diya jata hai. OOM poora raw master
// (~28k rows × nested lumpsum/systematic) + nav dump ek saath rakhne se hota tha; mapped
// rows flat hain (~30MB) aur nav dump ab AMFI se aata hai, BSE se nahi. CHUNK barhane se
// requests kam par peak memory zyada — 2000 par dono theek rehte hain.
// ponytail: single process-wide index. Multi-instance hone par redis, tab tak har box
// apni copy rakhta hai — 6 ghante mein ek baar ka refresh hai, mehnga nahi.
const CHUNK = 2000;
const MASTER_TTL_MS = 6 * 60 * 60 * 1000;
// 28k rows at the smallest page BSE has ever served us still finishes inside this.
const MAX_CHUNKS = 400;
// How long a cold request waits for the index before falling back to a single BSE page.
const COLD_WAIT_MS = 2500;

let master = { at: 0, list: [], fields: [] };
let masterInflight = null;

async function buildMaster(controller) {
  const list = [];
  let fields = [];
  // ponytail: BSE apni marzi se page chhota kar sakta hai. Agar hum CHUNK maangein aur wo
  // kam bheje, to "rows.length < chunk" pehle hi page par loop tor deta aur catalogue
  // chupchaap adhoora reh jata. Is liye jo usne asal mein bheja wahi aage ka chunk hai.
  let chunk = CHUNK;
  let start = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const res = await fetchPage(controller, start, chunk);
    const rows = res?.data?.lists || [];
    if (!rows.length) break;
    if (i === 0 && rows.length < chunk) chunk = rows.length;
    if (!fields.length) fields = Object.keys(rows[0]);
    // ponytail: physical-only schemes ab list mein rehti hain aur `physical_only` par
    // badge dikhta hai — chhupane se investor ko pata hi nahi chalta ke fund mojood hai.
    // Order phir bhi nahi ja sakta (UCC demat par hai, BSE msgid 1020 phys_ucc deta hai);
    // rok MutualFundInvestPage ke `dematBlocked` par hai, list par nahi.
    for (const row of rows) if (isTransactable(row)) list.push(mapScheme(row, list.length));
    const count = Number(res?.data?.count);
    start += rows.length;
    if (rows.length < chunk) break;
    if (Number.isFinite(count) && start >= count) break;
  }
  return { at: Date.now(), list, fields };
}

/** Mapped, transactable master. Refreshed at most once per TTL, one build at a time. */
async function getMaster(controller) {
  const fresh = master.list.length && Date.now() - master.at < MASTER_TTL_MS;
  if (fresh) return master;
  if (!masterInflight) {
    masterInflight = buildMaster(controller)
      .then((next) => (master = next))
      .catch((err) => {
        // Purana index dikhana 502 se behtar — master roz mushkil se badalta hai. Bilkul
        // khali ho to error upar jaye, taake AMFI fallback / stale-cache chal sakein.
        if (!master.list.length) throw err;
        console.warn("[mf] master refresh failed, serving cached index:", err.message);
        return master;
      })
      .finally(() => {
        masterInflight = null;
      });
  }
  // ponytail: stale-while-revalidate. Measured against the live BSE host a full build is
  // ~5.8 minutes for 11k schemes; awaiting it at the 6-hour boundary would hang the fund
  // list for that long. Master roz mushkil se badalta hai, to purana index dikhao aur
  // refresh peechhe chalne do.
  if (master.list.length) return master;
  return masterInflight;
}

/**
 * ponytail: pehli hi request ko 5.8 minute mat rulao. Index khali ho to BSE se sirf ek
 * page mangwa kar dikha do (yehi purana behaviour tha) aur build peechhe chalta rahe.
 * `total` yahan sirf isi page ka hai, is liye `warming: true` bhejte hain — jhooti 28k
 * ginti wapas nahi laate. Ye window ek baar hoti hai, container restart ke baad.
 */
async function coldPage(controller, q, start, length) {
  const res = await fetchPage(controller, start, Math.min(FETCH_MAX, Math.max(length * 2, length)));
  const rows = (res?.data?.lists || []).filter(isTransactable).map((row, i) => mapScheme(row, i));
  const amfi = (await getAmfiNavs()).navs;
  const hidden = await getHidden();
  const navOf = (item) => item.nav ?? navFor(amfi, item.scheme_isin, item.scheme_bse_code);
  const shown = rows.filter((item) => !isHidden(hidden, item));
  const priced = shown.filter((item) => navOf(item) != null);
  const cats = await getCategories();
  const { lists } = query(priced, { ...q, start: 0, length });
  const list = lists.map((item) => ({
    ...item,
    nav: navOf(item),
    nav_date: item.nav_date || navDateFor(amfi, item.scheme_isin, item.scheme_bse_code),
    nav_loaded: true,
    admin_category: categoryOf(cats, item),
  }));

  return {
    list,
    total: list.length,
    unpriced: shown.length - priced.length,
    priced: priced.length,
    fetched: rows.length,
    fields: rows.length ? Object.keys(rows[0]) : [],
    sample: null,
    warming: true,
  };
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

  // Cold cache: give the build a couple of seconds, then stop waiting and serve one BSE
  // page while it finishes in the background. A real build is ~5.8 minutes; nobody should
  // sit through that. A cheap/stubbed build wins the race and is used straight away.
  if (!master.list.length) {
    const building = getMaster(controller).catch((err) => {
      console.warn("[mf] master build failed:", err.message);
      return null;
    });
    const timer = new Promise((resolve) => setTimeout(resolve, COLD_WAIT_MS).unref?.());
    await Promise.race([building, timer]);
    if (!master.list.length) {
      try {
        return await coldPage(controller, q, start, length);
      } catch (err) {
        if (!AMFI_FALLBACK) throw err;
        console.warn("[mf] cold page fetch failed:", err.message);
        return amfiCatalogue(q);
      }
    }
  }

  let index;
  try {
    index = await getMaster(controller);
  } catch (err) {
    // Login can succeed off cached creds and still time out on the master fetch.
    if (!AMFI_FALLBACK) throw err;
    console.warn("[mf] BSE master fetch failed:", err.message);
    return amfiCatalogue(q);
  }

  const amfi = (await getAmfiNavs()).navs;
  const hidden = await getHidden();
  const navOf = (item) => item.nav ?? navFor(amfi, item.scheme_isin, item.scheme_bse_code);
  // Admin ne is scheme ko chhupaya hai — list se bahar, aur unpriced bhi nahi ginti.
  const shown = index.list.filter((item) => !isHidden(hidden, item));
  const priced = shown.filter((item) => navOf(item) != null);

  // ponytail: filter aur count poore catalogue par, page uske BAAD kata jata hai —
  // isi liye `total` ab sach hai. Sirf lauti hui rows clone hoti hain, warna har
  // request 28k object allocate karti. Naapa hua kharcha: 28k rows par 2-7 ms CPU,
  // koi network call nahi. Isse zyada chahiye to derived index per-filter cache
  // karna parega, abhi controller ka 5-minute listCache hi kaafi hai.
  // Admin's classification rides along on the returned page only — it changes far more
  // often than the master index, so it must not be baked into it.
  const cats = await getCategories();
  const { total, lists } = query(priced, { ...q, start, length });
  const list = lists.map((item) => ({
    ...item,
    nav: navOf(item),
    nav_date: item.nav_date || navDateFor(amfi, item.scheme_isin, item.scheme_bse_code),
    nav_loaded: true,
    admin_category: categoryOf(cats, item),
  }));

  return {
    list,
    total,
    unpriced: shown.length - priced.length,
    priced: priced.length,
    fetched: index.list.length,
    // ponytail: BSE ke row mein asli field kaunse hain — mapScheme jo naam dhoondta hai
    // wo mil bhi rahe hain ya nahi, ye batata hai. `isTransactable` chup chaap sach maan
    // leta hai jab flag na mile, is liye ye dikhna zaroori hai.
    fields: index.fields,
    // ponytail: raw row ab index build par chhod diya jata hai, is liye sample null hai.
    // Key rehne di taake payload ki shape na badle. Raw row chahiye to lookupScheme
    // (StarMFController) usi scheme ko BSE se seedha maang leta hai.
    sample: null,
  };
}

const haystack = (f) => `${f.name || ""} ${f.scheme_isin || ""} ${f.scheme_bse_code || ""} ${f.scheme_amc_name || ""}`.toLowerCase();

// YES/NO filters BSE ke apne per-scheme flags par lagte hain: `sip_allowed` (systematic[]
// ka sip_flag) aur `holding_modes` (lumpsum[] ka demat/physical). null ka matlab "BSE ne
// bataya hi nahi" — usay "no" mat ginna, warna filter aadhi list kha jata hai.
// Yeh exclusion jaan-boojh kar hai aur ab chupi hui nahi: `total` filter ke BAAD ginta
// hai, is liye user ko wahi ginti dikhti hai jitni rows usay milti hain.
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

/**
 * Boot warm-up. Builds the index before anyone asks, so the first investor is not the one
 * who starts a ~5.8 minute build. Safe to fail: getCatalogue retries on its own.
 */
async function warmCatalogue(controller) {
  if (!controller.accessToken) await controller.loginFunc();
  if (!controller.accessToken) return;
  const t0 = Date.now();
  const index = await getMaster(controller);
  console.log(`[mf] master index warm: ${index.list.length} schemes in ${Date.now() - t0}ms`);
}

module.exports = { getCatalogue, query, warmCatalogue, AMFI_FALLBACK };
