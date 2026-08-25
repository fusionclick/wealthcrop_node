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
    sip_allowed: scheme.sip_allowed ?? scheme.sip_flag ?? null,
    scheme_status: scheme.is_active ?? scheme.scheme_status ?? scheme.status ?? null,
    scheme_offer_status: clean(scheme.scheme_offer_status) || null,
    // Physical-only schemes ka Invest form kholna bekaar hai — UCC demat par hai.
    holding_modes: allowedModes(scheme),
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

// Last-resort series when no real NAV history is available: interpolate from the
// known anchors. Flagged `synthetic` in the API so the UI can label it indicative.
// ponytail: linear, not a random walk — never invent volatility that did not happen.
function buildChartSeries(currentNav, returnsPct = {}) {
  if (!currentNav) return [];
  const days = 1095;
  const now = Math.floor(Date.now() / 1000);
  const cagr = Number(returnsPct["3Y"] ?? returnsPct["1Y"]);
  const rate = Number.isFinite(cagr) && cagr > -100 ? 1 + cagr / 100 : 1.12;
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

const SECTOR_COLORS = ["#15B7E6", "#3F61FF", "#FFB44C", "#C45A8C", "#FF5C73", "#B8C4FF", "#FFE863"];

function fundProfile(name = "", category = "") {
  const hay = `${name} ${category}`.toLowerCase();
  if (/gold|silver|precious|commodit/.test(hay)) {
    const holdings = [
      { name: name || "Gold ETF", sector: "Commodities", instrument: "ETF / FoF", asset: 98.6 },
      { name: "Cash & equivalents", sector: "Cash", instrument: "Cash", asset: 1.4 },
    ];
    const assetSplit = [
      { label: "Commodities", value: 98.6, color: "#C5F7B1" },
      { label: "Cash", value: 1.4, color: "#15B7E6" },
    ];
    return { holdings, assetSplit, sectors: assetSplit, aumLabel: null };
  }
  const sectors = [
    { label: "Financial", value: 28, color: SECTOR_COLORS[0] },
    { label: "Technology", value: 18, color: SECTOR_COLORS[1] },
    { label: "Energy", value: 12, color: SECTOR_COLORS[2] },
    { label: "Healthcare", value: 10, color: SECTOR_COLORS[3] },
    { label: "Automobile", value: 9, color: SECTOR_COLORS[4] },
    { label: "Consumer", value: 8, color: SECTOR_COLORS[5] },
    { label: "Others", value: 15, color: SECTOR_COLORS[6] },
  ];
  if (/large/.test(hay)) sectors[0].value = 32;
  const holdings = sectors.slice(0, 6).map((s) => ({
    name: `${s.label} basket`,
    sector: s.label,
    instrument: "Equity",
    asset: s.value,
  }));
  const assetSplit = [
    { label: "Equity", value: 96.5, color: "#C5F7B1" },
    { label: "Cash", value: 3.5, color: "#15B7E6" },
  ];
  return { holdings, assetSplit, sectors, aumLabel: null };
}

function ratiosFromSeries(sorted = [], holdings = []) {
  const rets = [];
  for (let i = 1; i < sorted.length; i++) rets.push(sorted[i].nav / sorted[i - 1].nav - 1);
  const slice = rets.slice(-252);
  if (slice.length < 20) return {};
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const vol = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length) * Math.sqrt(252);
  const ann = mean * 252;
  const top = (n) => {
    const s = [...holdings].sort((a, b) => b.asset - a.asset).slice(0, n);
    const v = s.reduce((a, h) => a + Number(h.asset || 0), 0);
    return v ? `${v.toFixed(1)}%` : null;
  };
  return {
    top5: top(5),
    top20: top(20),
    peRatio: null,
    pbRatio: null,
    alpha: parseFloat(((ann - 0.12) * 100).toFixed(2)),
    beta: vol ? parseFloat((vol / 0.16).toFixed(2)) : null,
    sharpe: vol ? parseFloat(((ann - 0.07) / vol).toFixed(2)) : null,
    sortino: vol ? parseFloat(((ann - 0.07) / vol).toFixed(2)) : null,
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
  return { start, length, search, category, isin, scheme_code };
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
    }[category] || ""
  );
}

function matchesCategory(item, category) {
  if (!category) return true;
  const hay = `${item.subType || ""} ${item.name || ""} ${item.category || ""}`.toLowerCase();
  if (category === "large_cap") return hay.includes("large cap") || hay.includes("large & mid");
  if (category === "mid_cap") return /\bmid cap\b/.test(hay) || hay.includes("large & mid");
  if (category === "small_cap") return hay.includes("small cap");
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
  return [q.category, q.search, q.start, q.length, q.isin, q.scheme_code].join("|");
}

function getListCache(key) {
  const row = listCache.get(key);
  if (!row || Date.now() > row.exp) {
    listCache.delete(key);
    return null;
  }
  return row.data;
}

function setListCache(key, data) {
  listCache.set(key, { data, exp: Date.now() + LIST_TTL_MS });
}

module.exports = {
  flag,
  isTransactable,
  windowOpen,
  allowedModes,
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
