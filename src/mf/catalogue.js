const { mapScheme, isTransactable, matchesCategory } = require("./scheme");
const { getAmfiNavs } = require("./amfiNav");
const { navFor, navDateFor } = require("./navStore");
const { getHidden, isHidden } = require("./hidden");
const { getCategories, categoryOf } = require("./categories");
const { enrichRows, warmEnrichment, applyCached, enrichmentStats } = require("./kuvera");

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
// A partial index is served but re-tried on this cadence instead of the full TTL.
const PARTIAL_RETRY_MS = 5 * 60 * 1000;

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
  let reported = null;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const res = await fetchPage(controller, start, chunk);
    const rows = res?.data?.lists || [];
    if (!rows.length) break;
    // Adapt on ANY short page, not just the first: BSE can shrink the page mid-stream, and
    // "shrank" then read as "finished", committing a truncated catalogue for 6 hours.
    if (rows.length < chunk) chunk = rows.length;
    if (!fields.length) fields = Object.keys(rows[0]);
    // ponytail: physical-only schemes ab list mein rehti hain aur `physical_only` par
    // badge dikhta hai — chhupane se investor ko pata hi nahi chalta ke fund mojood hai.
    // Order phir bhi nahi ja sakta (UCC demat par hai, BSE msgid 1020 phys_ucc deta hai);
    // rok MutualFundInvestPage ke `dematBlocked` par hai, list par nahi.
    for (const row of rows) if (isTransactable(row)) list.push(mapScheme(row, list.length));
    const count = Number(res?.data?.count);
    if (Number.isFinite(count)) reported = count;
    start += rows.length;
    if (Number.isFinite(count) && start >= count) break;
  }
  // A truncated index silently hides funds and makes `total` wrong. Serving what we have
  // still beats an empty catalogue, so don't throw — but say so, and back-date `at` so the
  // next request retries in minutes instead of sitting on a partial list for six hours.
  const partial = reported != null && start < reported;
  if (partial) {
    console.warn(`[mf] master build stopped at ${start} of ${reported} rows — serving a partial catalogue, retrying soon`);
  }
  return { at: partial ? Date.now() - MASTER_TTL_MS + PARTIAL_RETRY_MS : Date.now(), list, fields };
}

/** Mapped, transactable master. Refreshed at most once per TTL, one build at a time. */
async function getMaster(controller) {
  const fresh = master.list.length && Date.now() - master.at < MASTER_TTL_MS;
  if (fresh) return master;
  if (!masterInflight) {
    masterInflight = buildMaster(controller)
      // An empty build must never replace a good index: doing so put a stale-but-usable
      // catalogue back to zero and sent the next request into a full ~6 minute await.
      .then((next) => {
        if (!next.list.length) return master;
        master = next;
        // Risk / fund age / returns live in the enrichment cache, not in BSE's master, and
        // the FILTERS read them off the index row. Re-attach whatever is already cached
        // the moment a rebuild lands, then let the warmer fill the rest in the background.
        for (const row of master.list) applyCached(row);
        warmEnrichment(master.list).catch((err) => console.warn("[mf] enrichment warm failed:", err.message));
        return master;
      })
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
  const list = await enrichRows(
    lists.map((item) => ({
      ...item,
      nav: navOf(item),
      nav_date: item.nav_date || navDateFor(amfi, item.scheme_isin, item.scheme_bse_code),
      nav_loaded: true,
      admin_category: categoryOf(cats, item),
    }))
  );

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
  // Enrichment for the rows actually being returned: the warm pass fills the index in the
  // background, this makes sure the 20 rows on screen are not waiting for it.
  const list = await enrichRows(
    lists.map((item) => ({
      ...item,
      nav: navOf(item),
      nav_date: item.nav_date || navDateFor(amfi, item.scheme_isin, item.scheme_bse_code),
      nav_loaded: true,
      admin_category: categoryOf(cats, item),
    }))
  );

  return {
    list,
    total,
    enrichment: enrichmentStats(),
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

const csv = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Ticket 11's "transaction availability" filter. Every key reads a flag BSE itself
// published for that scheme (see schemeTransactions in mf/scheme.js); `null` means BSE did
// not say and is NOT treated as "yes" — a filter must never widen itself on missing data.
const TXN_FILTERS = {
  lumpsum: (f) => f.txn?.lumpsum === true,
  sip: (f) => f.txn?.sip === true,
  swp: (f) => f.txn?.swp === true,
  stp: (f) => f.txn?.stp === true,
  switch: (f) => f.txn?.switchAllowed === true,
  redemption: (f) => f.txn?.redemption === true,
  // Ticket 2 — what the scheme does with distributed income. Not a lumpsum[]/systematic[]
  // rulebook like the rest: it is BSE's own scheme_option, normalised by payoutOf(), and
  // sits on the same index row as `txn`.
  idcw_payout: (f) => f.payout === "IDCW Payout",
  idcw_reinvest: (f) => f.payout === "IDCW Reinvestment",
};

// Ranking. Only metrics that are actually on an index row — returns/age/rating arrive from
// the enrichment warm pass, the rest are BSE's own. Nulls always sink to the bottom in both
// directions: an unknown 3Y return must not win a "best 3Y" sort.
const SORTS = {
  returns_1y: (f) => f.returns?.["1Y"],
  returns_3y: (f) => f.returns?.["3Y"],
  returns_5y: (f) => f.returns?.["5Y"],
  age: (f) => f.ageYears,
  // Ticket 11 — rank by fund size. Already ₹ crore; normalised in kuvera.js.
  aum: (f) => f.aum,
  rating: (f) => f.fundRating,
  risk: (f) => f.riskRank,
  min_sip: (f) => f.minSip,
  min_lumpsum: (f) => f.minLumpsum,
  expense: (f) => (f.expense == null ? null : Number(String(f.expense).replace(/[^0-9.]/g, "")) || null),
  nav: (f) => f.nav,
  name: (f) => f.name,
};

function sortRows(rows, sort, order = "desc") {
  const pick = SORTS[sort];
  if (!pick) return rows;
  const dir = String(order).toLowerCase() === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    const xn = x == null || x === "" || Number.isNaN(x);
    const yn = y == null || y === "" || Number.isNaN(y);
    if (xn && yn) return 0;
    if (xn) return 1;
    if (yn) return -1;
    if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * dir;
    return (x - y) * dir;
  });
}

function query(
  list = [],
  {
    search = "",
    category = "",
    isin = "",
    scheme_code = "",
    plan = "",
    sip = "",
    mode = "",
    risk = "",
    txn = "",
    minAge = null,
    maxAge = null,
    // Ticket 11 — fund size band, in ₹ crore.
    minAum = null,
    maxAum = null,
    minReturn = null,
    returnPeriod = "1Y",
    sort = "",
    order = "desc",
    start = 0,
    length = 20,
  } = {}
) {
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

  const risks = csv(risk).map((r) => r.toLowerCase());
  if (risks.length) rows = rows.filter((f) => f.risk && risks.includes(String(f.risk).toLowerCase()));

  // Several transaction types = ALL of them, not any: "SIP and SWP" means a scheme that
  // supports both.
  for (const key of csv(txn).map((t) => t.toLowerCase())) {
    const test = TXN_FILTERS[key];
    if (test) rows = rows.filter(test);
  }

  if (minAge != null) rows = rows.filter((f) => f.ageYears != null && f.ageYears >= minAge);
  if (maxAge != null) rows = rows.filter((f) => f.ageYears != null && f.ageYears <= maxAge);
  // Ticket 11 — a fund with no published size is excluded from an explicit size band rather
  // than assumed to be zero, the same rule the age filter above already follows.
  if (minAum != null) rows = rows.filter((f) => f.aum != null && f.aum >= minAum);
  if (maxAum != null) rows = rows.filter((f) => f.aum != null && f.aum <= maxAum);
  if (minReturn != null) {
    const key = String(returnPeriod || "1Y").toUpperCase();
    rows = rows.filter((f) => f.returns?.[key] != null && f.returns[key] >= minReturn);
  }

  const q = String(search || "").trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    rows = rows.filter((f) => {
      const hay = haystack(f);
      return terms.every((t) => hay.includes(t));
    });
  }
  if (sort) rows = sortRows(rows, sort, order);
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

/**
 * {ISIN|BSE code: category} from the master index, for callers that hold a scheme
 * identifier but no category — BSE's order_list is the one that matters: it names the
 * scheme and the folio but never its category, so every portfolio row defaulted to
 * "Mutual Fund" and the allocation pie drew a single slice for every investor.
 *
 * Reads the index only if it is already built. A cold index would mean awaiting a ~6
 * minute build inside a portfolio request, and a portfolio is still perfectly usable with
 * the caller's own fallback label — so this returns {} instead and the pie recovers on the
 * next load, once the boot warm-up has finished.
 */
function schemeCategories() {
  const out = {};
  for (const item of master.list) {
    const label = item.subType || item.category;
    if (!label) continue;
    for (const k of [item.scheme_isin, item.scheme_bse_code]) {
      const key = String(k || "").trim().toUpperCase();
      if (key) out[key] = label;
    }
  }
  return out;
}

module.exports = { getCatalogue, query, warmCatalogue, schemeCategories, AMFI_FALLBACK };
