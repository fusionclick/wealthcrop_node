const NO = new Set(["n", "no", "false", "0", "inactive", "closed", "disabled", "not allowed"]);
const YES = new Set(["y", "yes", "true", "1", "allowed", "active", "open"]);

function flag(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (NO.has(s)) return false;
  if (YES.has(s)) return true;
  return null;
}

// BSE master ke asli field naam: is_active, amc_active_flag, scheme_offer_status,
// lumpsum, systematic. Purana code purchase_allowed/scheme_status dhoondta tha jo BSE
// bhejta hi nahi — is liye har scheme "allowed" nikalti thi aur band schemes order par
// record_not_found de deti thin.
const CLOSED_OFFER = /^(close|closed|suspend|suspended|inactive|matured|wound)/i;

// ponytail: `lumpsum` object ki shape confirm nahi — sirf saaf inkar par rok lagti hai,
// warna filter poori list kha jayega. Shape maloom hote hi seedha field padh lena.
function lumpsumBlocked(l) {
  if (l == null) return false;
  if (typeof l !== "object") return flag(l) === false;
  return flag(l.allowed ?? l.purchase_allowed ?? l.purchase ?? l.is_allowed) === false;
}

// BSE har transaction type ka window deta hai. Chalti hui schemes par end date
// 2037-12-31 hoti hai; mare hue rows par guzri hui (FR011-DP: 2025-06-20). Window
// band ho to order bhi reject hoga, is liye check yahin — list aur order dono isi
// se guzarte hain.
function windowOpen(scheme, txnType = "Purchase", now = Date.now()) {
  const rows = Array.isArray(scheme?.lumpsum) ? scheme.lumpsum : [];
  const row = rows.find(
    (r) => String(r?.scheme_transaction_type || "").toLowerCase() === txnType.toLowerCase()
  );
  if (!row) return true;
  const start = Date.parse(row.scheme_transaction_effective_start_date);
  if (Number.isFinite(start) && now < start) return false;
  const end = Date.parse(row.scheme_transaction_effective_end_date);
  return Number.isFinite(end) ? now <= end : true;
}

function isTransactable(scheme = {}) {
  if (flag(scheme.is_active ?? scheme.scheme_status ?? scheme.status) === false) return false;
  if (flag(scheme.amc_active_flag) === false) return false;
  if (CLOSED_OFFER.test(String(scheme.scheme_offer_status || "").trim())) return false;
  if (lumpsumBlocked(scheme.lumpsum)) return false;
  if (!windowOpen(scheme)) return false;
  if (flag(scheme.purchase_allowed ?? scheme.purchase_allow ?? scheme.txn_allowed) === false) {
    return false;
  }
  return true;
}

// BSE returns literal "Not Specified" / "NA" for unclassified schemes — treat as blank.
const BLANK = /^(not specified|na|n\/a|none|-|null)$/i;
function clean(v) {
  const s = String(v ?? "").trim();
  return !s || BLANK.test(s) ? "" : s;
}

// Fall back to the scheme name when BSE gives no category.
const NAME_CATEGORIES = [
  [/\belss\b|tax saver/i, "Equity", "ELSS"],
  [/large\s*(&|and)\s*mid/i, "Equity", "Large & Mid Cap"],
  [/\blarge\s*cap\b/i, "Equity", "Large Cap"],
  [/\bmid\s*cap\b/i, "Equity", "Mid Cap"],
  [/\bsmall\s*cap\b/i, "Equity", "Small Cap"],
  [/flexi\s*cap|multi\s*cap/i, "Equity", "Flexi Cap"],
  [/\bindex\b|\bnifty\b|\bsensex\b|\betf\b/i, "Other", "Index / ETF"],
  [/\bgold\b|\bsilver\b|precious/i, "Other", "Commodities"],
  [/pension|retirement|children/i, "Solution Oriented", "Retirement Fund"],
  [/liquid|overnight|money market/i, "Debt", "Liquid"],
  [/\bdebt\b|\bbond\b|\bgilt\b|\bincome\b|duration/i, "Debt", "Debt"],
  [/hybrid|balanced|arbitrage|asset alloc/i, "Hybrid", "Hybrid"],
  [/\besg\b|thematic|sector|infra|banking|pharma|technolog|healthcare|consumption|global|international/i, "Equity", "Sectoral / Thematic"],
  [/long term equity|taxgain/i, "Equity", "ELSS"],
  [/constant maturity|savings fund|treasury|credit risk|corporate bond|banking\s*(&|and)\s*psu/i, "Debt", "Debt"],
  [/\bcontra\b|value fund|focused|dividend yield|\bequity\b/i, "Equity", "Equity"],
];
function categoryFromName(name = "") {
  const hit = NAME_CATEGORIES.find(([re]) => re.test(name));
  return hit ? { category: hit[1], sub: hit[2] } : { category: "", sub: "" };
}

// BSE har scheme ke liye batata hai ke wo Demat leta hai ya Physical, aur ye
// transaction type ke hisab se alag hota hai — `lumpsum[]` mein Purchase/Redemption/
// Switch ki apni apni entry hoti hai. Kuch schemes (jaise Franklin Pension Plan) sirf
// Physical hain, aur unhein "D" bhejne par BSE msgid 1588 "PhysOrDemat not_allowed" deta hai.
function allowedModes(scheme, txnType = "Purchase") {
  const rows = Array.isArray(scheme?.lumpsum) ? scheme.lumpsum : [];
  const row = rows.find(
    (r) => String(r?.scheme_transaction_type || "").toLowerCase() === txnType.toLowerCase()
  );
  const raw = row?.scheme_transaction_mode_allowed || scheme?.scheme_transaction_mode_allowed;
  if (!Array.isArray(raw) || !raw.length) return null;
  const modes = raw.map((m) => String(m?.scheme_transaction_mode_demat_physical_allowed || "").toLowerCase());
  return { demat: modes.includes("demat"), physical: modes.includes("physical") };
}

// BSE `systematic[]` mein har SIP frequency ki apni row hoti hai aur `sip_flag` "Y"/"N".
// Ek bhi row par Y ho to scheme SIP leti hai. Array hi na ho to jawab null — "pata nahi",
// false nahi, warna har scheme "SIP: No" dikhne lagti.
function sipAllowed(scheme = {}) {
  const rows = Array.isArray(scheme.systematic) ? scheme.systematic : [];
  if (!rows.length) return flag(scheme.sip_allowed ?? scheme.sip_flag);
  const flags = rows.map((r) => flag(r?.sip_flag ?? r?.systematic_sip_flag ?? r?.sip_allowed));
  if (flags.some((f) => f === true)) return true;
  return flags.some((f) => f === false) ? false : null;
}

// Direct = investor seedha AMC se khareedta hai (koi commission nahi). Regular = distributor
// ke through, trail commission isi par milta hai. BSE `scheme_plan` bhejta hai; khali ho to
// naam mein hamesha likha hota hai.
// ponytail: koi lafz na mile to "Regular" — null dene se scheme Regular aur Direct
// DONO filters se gayab ho jati thi. SEBI ke tehat Direct plan ka naam mein "Direct"
// likhna lazmi hai; Regular wale aksar lafz likhte hi nahi (jaise "HDFC Flexi Cap").
// Is liye "koi lafz nahi" ka sahi jawab Regular hai, "pata nahi" nahi.
function planOf(scheme = {}) {
  const hay = `${scheme.scheme_plan || ""} ${scheme.name || scheme.scheme_name || ""}`;
  return /\bdirect\b/i.test(hay) ? "Direct" : "Regular";
}

function mapScheme(scheme = {}, index = 0) {
  const name = scheme.name || scheme.scheme_name || "";
  const isin = scheme.scheme_isin || scheme.isin || "";
  const bseCode = scheme.scheme_bse_code || scheme.bse_scheme_code || "";
  const guess = categoryFromName(name);
  const category = clean(scheme.scheme_category) || guess.category;
  const sub = clean(scheme.scheme_sub_category) || guess.sub;
  const minLumpsum = scheme.min_lumpsum_amount ?? scheme.min_amt ?? scheme.minLumpsum;
  const minSip = scheme.sip_min_amount ?? scheme.min_sip_amount ?? scheme.sip_minimum_amount ?? scheme.sip_min_amt ?? scheme.minSip;

  const minRedeem = scheme.min_redemption_amount ?? scheme.min_redeem_amt;
  const nav = scheme.nav ?? scheme.nav_value;
  const modes = allowedModes(scheme);
  return {
    id: index + 1,
    name,
    category: category || "Mutual Fund",
    subType: [...new Set([category, sub].filter(Boolean))].join(" • ") || "Mutual Fund",
    scheme_isin: isin,
    scheme_bse_code: bseCode,
    nav: nav != null && nav !== "" ? Number(nav) : null,
    minSip: minSip != null && minSip !== "" ? Number(minSip) : null,
    minLumpsum: minLumpsum != null && minLumpsum !== "" ? Number(minLumpsum) : null,
    minRedeem: minRedeem != null && minRedeem !== "" ? Number(minRedeem) : null,
    purchase_allowed: scheme.purchase_allowed ?? scheme.purchase_allow ?? null,
    sip_allowed: sipAllowed(scheme),
    scheme_status: scheme.is_active ?? scheme.scheme_status ?? scheme.status ?? null,
    scheme_offer_status: clean(scheme.scheme_offer_status) || null,
    // Physical-only schemes ka Invest form kholna bekaar hai — UCC demat par hai.
    holding_modes: modes,
    physical_only: modes ? modes.physical === true && modes.demat === false : false,
    plan: planOf(scheme),
    scheme_plan: clean(scheme.scheme_plan) || null,
    scheme_option: clean(scheme.scheme_option) || null,
    scheme_amc_name: clean(scheme.scheme_amc_name || scheme.amc_name) || null,
    expense: clean(scheme.expense_ratio || scheme.scheme_expense_ratio || scheme.expense) || null,
    exitLoad: clean(scheme.exit_load || scheme.scheme_exit_load) || null,
    risk: clean(scheme.scheme_riskometer || scheme.riskometer || scheme.risk) || null,
    logoText: name ? name.charAt(0).toUpperCase() : "F",
    returns: { "1Y": null, "3Y": null, "5Y": null },
  };
}

function pickScheme(lists = [], isin, code) {
  const i = String(isin || "").trim().toUpperCase();
  const c = String(code || "").trim().toUpperCase();
  return (
    lists.find((item) => {
      const bse = String(item.scheme_bse_code || item.bse_scheme_code || "").trim().toUpperCase();
      const isinCode = String(item.scheme_isin || item.isin || "").trim().toUpperCase();
      return (c && bse === c) || (i && isinCode === i);
    }) || lists[0] || null
  );
}

function navLookup(map, isin, code) {
  const i = String(isin || "").trim().toUpperCase();
  const c = String(code || "").trim().toUpperCase();
  const n = parseFloat(map[i]?.nav || map[c]?.nav || 0);
  return n > 0 ? n : null;
}

function calcReturns(currentNav, anchors = {}) {
  const one = (past, years) => {
    if (!currentNav || !past || past <= 0) return null;
    if (years === 1) return parseFloat((((currentNav - past) / past) * 100).toFixed(2));
    return parseFloat(((Math.pow(currentNav / past, 1 / years) - 1) * 100).toFixed(2));
  };
  return {
    "1Y": one(anchors["1Y"], 1),
    "3Y": one(anchors["3Y"], 3),
    "5Y": one(anchors["5Y"], 5),
  };
}

// Last-resort series when no real NAV history is available: interpolate between today's
// NAV and a KNOWN past return. Flagged `synthetic` so the UI labels it indicative.
// ponytail: linear, not a random walk — never invent volatility that did not happen.
//
// Two ways this used to invent data outright, both removed:
//   - `Number(null)` is 0, not NaN, so a scheme with no known returns took the "0% CAGR"
//     branch and drew a dead-flat line across three years at today's NAV. On screen that
//     reads as a fund that has never moved, which is a stronger claim than "unknown".
//   - The remaining fallback was a hardcoded 1.12, i.e. a 12% annual return nobody
//     reported. An empty series and the UI's "NAV chart unavailable" is the honest answer.
function buildChartSeries(currentNav, returnsPct = {}) {
  if (!currentNav) return [];
  const raw = returnsPct?.["3Y"] ?? returnsPct?.["1Y"];
  const cagr = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(cagr) || cagr <= -100) return [];
  const days = 1095;
  const now = Math.floor(Date.now() / 1000);
  const rate = 1 + cagr / 100;
  const startNav = currentNav / Math.pow(rate, days / 365);
  const out = [];
  for (let i = 0; i <= days; i += 3) {
    out.push({
      timestamp: now - (days - i) * 86400,
      nav: parseFloat((startNav + ((currentNav - startNav) * i) / days).toFixed(4)),
    });
  }
  if (out[out.length - 1].timestamp !== now) out.push({ timestamp: now, nav: currentNav });
  return out;
}

function parseMfDate(dateStr) {
  const p = String(dateStr || "").split("-");
  if (p.length !== 3) return null;
  const [a, b, c] = p;
  const iso = a.length === 4 ? `${a}-${b}-${c}` : `${c}-${b}-${a}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function parseNavRows(rows = []) {
  return rows
    .map((r) => ({ timestamp: parseMfDate(r.date), nav: parseFloat(r.nav) }))
    .filter((r) => r.timestamp && r.nav > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function navAtOrBefore(sorted, ts) {
  let best = null;
  for (const p of sorted) {
    if (p.timestamp > ts) break;
    best = p;
  }
  return best;
}

function calcReturnsFromSeries(sorted = []) {
  if (!sorted.length) return { "1Y": null, "3Y": null, "5Y": null, ALL: null };
  const last = sorted[sorted.length - 1];
  const first = sorted[0];
  const at = (days) => navAtOrBefore(sorted, last.timestamp - days * 86400);
  const pct = (past, years, cagr) => {
    if (!past || !past.nav) return null;
    if (!cagr) return parseFloat((((last.nav - past.nav) / past.nav) * 100).toFixed(2));
    return parseFloat(((Math.pow(last.nav / past.nav, 1 / years) - 1) * 100).toFixed(2));
  };
  const yearsAll = Math.max((last.timestamp - first.timestamp) / (86400 * 365), 0.01);
  return {
    "1Y": pct(at(365), 1, false),
    "3Y": pct(at(1095), 3, true),
    "5Y": pct(at(1825), 5, true),
    ALL: pct(first, yearsAll, true),
  };
}

/**
 * One flat daily series, oldest first. The client slices the range and buckets the
 * interval, so the API never has to know which timeframe buttons exist.
 * Keeps the last year at full daily resolution and thins older history.
 */
function chartFromSeries(sorted = [], maxPoints = 3000) {
  if (sorted.length <= maxPoints) return sorted;
  const cut = sorted[sorted.length - 1].timestamp - 365 * 86400;
  const recent = sorted.filter((p) => p.timestamp >= cut);
  const older = sorted.filter((p) => p.timestamp < cut);
  const step = Math.max(1, Math.ceil(older.length / Math.max(1, maxPoints - recent.length)));
  return [...older.filter((_, i) => i % step === 0), ...recent];
}

function avgReturns(list = []) {
  const keys = ["1Y", "3Y", "5Y", "ALL"];
  const acc = {};
  keys.forEach((k) => {
    const nums = list.map((r) => r[k]).filter((v) => v != null && !Number.isNaN(v));
    acc[k] = nums.length ? parseFloat((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)) : null;
  });
  return acc;
}

function rankInPeers(mine, peers = [], key) {
  const rows = peers.map((p) => p[key]).filter((v) => v != null);
  if (mine == null || !rows.length) return null;
  return rows.filter((v) => v > mine).length + 1;
}

/**
 * Portfolio composition — holdings, equity/debt/cash split, sector weights.
 *
 * This used to RETURN INVENTED DATA and the fund page drew three charts from it. Every
 * equity scheme in the catalogue got the identical sector donut (Financial 28, Technology
 * 18, Energy 12, Healthcare 10, Automobile 9, Consumer 8, Others 15 — the only variation
 * in the whole function was bumping Financial to 32 if the name contained "large"), the
 * identical 96.5/3.5 equity-cash split, and a holdings table listing instruments named
 * "Financial basket" and "Technology basket" that do not exist. Gold funds got a
 * hardcoded 98.6/1.4.
 *
 * None of that is derivable from any feed we have. Holdings and sector weights come from
 * each AMC's monthly portfolio disclosure; AMFI's NAV feed does not carry them, BSE
 * StarMF does not expose them, and Kotak Neo's Trade API has no mutual-fund surface at
 * all. So there is nothing to compute here and inventing it on an investment platform is
 * worse than showing nothing.
 *
 * Empty arrays. The fund page already hides each section when its array is empty. Wire a
 * real portfolio-disclosure source (a data vendor, or per-AMC monthly files) and fill
 * these in; the charts light up again with no UI change.
 */
function fundProfile() {
  return { holdings: [], assetSplit: [], sectors: [], aumLabel: null };
}

/**
 * Risk metrics computed from the real NAV series — and only the ones it can actually
 * support.
 *
 * Removed, because each was a constant dressed as a measurement:
 *   alpha  = (annualised return - 0.12) * 100. That 0.12 is a 12% benchmark return
 *            invented here; alpha is defined against the scheme's own benchmark, which we
 *            do not have a price series for.
 *   beta   = volatility / 0.16. Beta is covariance with the benchmark divided by the
 *            benchmark's variance — it cannot be derived from the fund's own series at
 *            all, and 0.16 was a guess at market volatility.
 *   top5 / top20 = sums over the fabricated holdings above.
 *   sortino was character-for-character the sharpe formula, so the page printed the same
 *            number twice under two different definitions.
 *
 * What is left is real. Sortino now uses downside deviation, so it differs from sharpe.
 * riskFreeRate is returned alongside the ratios rather than buried, because a Sharpe
 * ratio without its risk-free rate is not interpretable.
 */
const RISK_FREE = 0.07; // ~1y Indian G-sec. Move to config when it needs to track.
const TRADING_DAYS = 252;

function ratiosFromSeries(sorted = []) {
  const rets = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].nav;
    if (prev > 0) rets.push(sorted[i].nav / prev - 1);
  }
  const slice = rets.slice(-TRADING_DAYS);
  if (slice.length < 20) return {};

  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const vol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
  const ann = mean * TRADING_DAYS;

  // Downside deviation: only returns below the daily risk-free hurdle count, which is
  // what makes sortino a different statistic from sharpe.
  const hurdle = RISK_FREE / TRADING_DAYS;
  const below = slice.filter((r) => r < hurdle).map((r) => (r - hurdle) ** 2);
  const downside = below.length
    ? Math.sqrt(below.reduce((a, b) => a + b, 0) / slice.length) * Math.sqrt(TRADING_DAYS)
    : 0;

  // Max drawdown over the same window: worst peak-to-trough fall an investor sat through.
  const window = sorted.slice(-(slice.length + 1));
  let peak = window[0]?.nav || 0;
  let maxDd = 0;
  for (const p of window) {
    if (p.nav > peak) peak = p.nav;
    if (peak > 0) maxDd = Math.min(maxDd, p.nav / peak - 1);
  }

  const r2 = (v) => parseFloat(v.toFixed(2));
  return {
    peRatio: null,
    pbRatio: null,
    volatility: vol ? r2(vol * 100) : null,
    sharpe: vol ? r2((ann - RISK_FREE) / vol) : null,
    sortino: downside ? r2((ann - RISK_FREE) / downside) : null,
    maxDrawdown: maxDd ? r2(maxDd * 100) : null,
    riskFreeRate: r2(RISK_FREE * 100),
    window: slice.length,
  };
}

function parseListQuery(body = {}) {
  const src = body.data && typeof body.data === "object" ? body.data : body;
  const start = Math.max(0, Number(src.start ?? 0) || 0);
  const length = Math.min(100, Math.max(1, Number(src.length ?? 20) || 20));
  const searchRaw = src.search && typeof src.search === "object" ? src.search.value : src.search;
  const search = String(searchRaw || body.search || "").trim();
  const category = String(body.category || src.category || src.filter_param?.scheme_category || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  const isin = String(body.isin || body.scheme_isin || src.scheme_isin || "").trim();
  const scheme_code = String(body.scheme_code || body.scheme_bse_code || src.scheme_code || "").trim();
  const plan = String(body.plan || src.plan || "").trim().toLowerCase();
  const sip = String(body.sip || src.sip || "").trim().toLowerCase();
  const mode = String(body.mode || src.mode || "").trim().toLowerCase();
  return { start, length, search, category, isin, scheme_code, plan, sip, mode };
}

function categorySearch(category) {
  return (
    {
      gold_funds: "GOLD",
      large_cap: "LARGE CAP",
      mid_cap: "MID CAP",
      small_cap: "SMALL CAP",
      high_return: "FLEXI CAP",
      "5_star_funds": "BLUECHIP",
      kotak_funds: "KOTAK",
    }[category] || ""
  );
}

function matchesCategory(item, category) {
  if (!category) return true;
  const hay = `${item.subType || ""} ${item.name || ""} ${item.category || ""}`.toLowerCase();
  if (category === "large_cap") return hay.includes("large cap") || hay.includes("large & mid");
  if (category === "mid_cap") return /\bmid cap\b/.test(hay) || hay.includes("large & mid");
  if (category === "small_cap") return hay.includes("small cap");
  if (category === "kotak_funds") {
    return /kotak/i.test(`${item.scheme_amc_name || ""} ${item.name || ""}`);
  }
  if (category === "gold_funds") {
    return /\bgold\b/.test(hay) || /\bsilver\b/.test(hay) || hay.includes("precious metal");
  }
  return true;
}

function paginate(list, start, length) {
  return list.slice(start, start + length);
}

const LIST_TTL_MS = 5 * 60 * 1000;
const listCache = new Map();

function listCacheKey(q = {}) {
  return [q.category, q.search, q.start, q.length, q.isin, q.scheme_code, q.plan, q.sip, q.mode].join("|");
}

const STALE_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * `allowStale` par expire ho chuki entry bhi wapas milti hai — BSE gir jaye to kal ka
 * page dikhana 502 se behtar hai. ponytail: fresh lookup expired row ko delete NAHI
 * karta, warna stale rescue ke waqt wo ja chuki hoti. Delete sirf STALE_MAX_MS ke baad,
 * taake Map hamesha ke liye barhta na rahe.
 */
function getListCache(key, allowStale = false) {
  const row = listCache.get(key);
  if (!row) return null;
  const age = Date.now() - row.exp;
  if (age <= 0) return row.data;
  if (age > STALE_MAX_MS) {
    listCache.delete(key);
    return null;
  }
  return allowStale ? row.data : null;
}

function setListCache(key, data) {
  listCache.set(key, { data, exp: Date.now() + LIST_TTL_MS });
}

module.exports = {
  flag,
  isTransactable,
  windowOpen,
  allowedModes,
  sipAllowed,
  planOf,
  mapScheme,
  pickScheme,
  navLookup,
  calcReturns,
  buildChartSeries,
  parseNavRows,
  calcReturnsFromSeries,
  chartFromSeries,
  avgReturns,
  rankInPeers,
  fundProfile,
  ratiosFromSeries,
  parseListQuery,
  matchesCategory,
  categorySearch,
  paginate,
  listCacheKey,
  getListCache,
  setListCache,
};
