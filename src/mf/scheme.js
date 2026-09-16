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
function windowOpenRow(row, now = Date.now()) {
  if (!row) return true;
  const start = Date.parse(row.scheme_transaction_effective_start_date);
  if (Number.isFinite(start) && now < start) return false;
  const end = Date.parse(row.scheme_transaction_effective_end_date);
  return Number.isFinite(end) ? now <= end : true;
}

function windowOpen(scheme, txnType = "Purchase", now = Date.now()) {
  const rows = Array.isArray(scheme?.lumpsum) ? scheme.lumpsum : [];
  const row = rows.find(
    (r) => String(r?.scheme_transaction_type || "").toLowerCase() === txnType.toLowerCase()
  );
  return windowOpenRow(row, now);
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

/**
 * Transaction attributes, straight out of BSE's own per-scheme rows.
 *
 * Probed live against the BSE master (300 schemes, fields:["ALL"]) — every scheme carries:
 *   lumpsum[]    -> Purchase | Redemption | Switch-IN | Switch-OUT
 *   systematic[] -> SIP | SWP | STP-IN | STP-OUT, one row PER FREQUENCY
 *                   (Daily | Weekly | Monthly | Quarterly)
 *
 * Each row brings its own money rules, so nothing here is a guess or a default:
 *   lumpsum    -> scheme_transaction_single_details.scheme_transaction_amt
 *   systematic -> systematic_transaction_detail[0].scheme_transaction_amt
 *                 + scheme_sxp_installment_numbers (min/max installments)
 *                 + scheme_sxp_frequency_detail.scheme_sxp_frequency_values = the ONLY
 *                   dates BSE will accept for that frequency.
 *
 * This is why `minSip`/`minLumpsum` used to come back null everywhere and the fund page
 * printed a hardcoded 500/5000: mapScheme was looking for flat fields (`sip_min_amount`,
 * `min_lumpsum_amount`…) that BSE has never sent. The real numbers were nested all along.
 */
const LUMP_TYPES = {
  Purchase: "lumpsum",
  Redemption: "redemption",
  "Switch-IN": "switchIn",
  "Switch-OUT": "switchOut",
};
const SXP_TYPES = { SIP: "sip", SWP: "swp", "STP-IN": "stpIn", "STP-OUT": "stpOut" };

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function amountsOf(node) {
  const a = node?.scheme_transaction_amt || {};
  return {
    minAmount: num(a.scheme_transaction_min_amt),
    minAdditional: num(a.scheme_transaction_min_adtnl_amt),
    maxAmount: num(a.scheme_transaction_max_amt),
    multiple: num(a.scheme_transaction_mult_amt),
  };
}

function modesOfRow(row) {
  const raw = row?.scheme_transaction_mode_allowed;
  if (!Array.isArray(raw) || !raw.length) return null;
  const modes = raw.map((m) => String(m?.scheme_transaction_mode_demat_physical_allowed || "").toLowerCase());
  return { demat: modes.includes("demat"), physical: modes.includes("physical") };
}

function schemeTransactions(scheme = {}, now = Date.now()) {
  const out = {};

  for (const row of Array.isArray(scheme.lumpsum) ? scheme.lumpsum : []) {
    const key = LUMP_TYPES[String(row?.scheme_transaction_type || "").trim()];
    if (!key) continue;
    out[key] = {
      allowed: windowOpenRow(row, now),
      ...amountsOf(row?.scheme_transaction_single_details),
      cutoff: row?.scheme_transaction_cutoff_time || null,
      modes: modesOfRow(row),
    };
  }

  for (const row of Array.isArray(scheme.systematic) ? scheme.systematic : []) {
    const key = SXP_TYPES[String(row?.scheme_transaction_type || "").trim()];
    if (!key) continue;
    const detail = (Array.isArray(row.systematic_transaction_detail) ? row.systematic_transaction_detail : [])[0] || {};
    const inst = detail.scheme_sxp_installment_numbers || {};
    const opts = row.scheme_transaction_allowed_options || {};
    // BSE returns the dates unsorted (SWP came back as [17,1,24,7,…]); a date picker that
    // lists them in that order is unusable.
    const dates = (row?.scheme_sxp_frequency_detail?.scheme_sxp_frequency_values || [])
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const open = windowOpenRow(row, now) && opts.scheme_sxp_registration_allowed !== false;
    const freq = {
      frequency: clean(row.scheme_sxp_frequency) || null,
      frequencyType: row?.scheme_sxp_frequency_detail?.scheme_sxp_frequency_type || null,
      dates,
      registrationAllowed: open,
      firstOrderTodayAllowed: opts.scheme_sxp_first_order_today_allowed === true,
      pauseAllowed: opts.scheme_sxp_paused === true,
      minInstallments: num(inst.scheme_sxp_min_installments),
      maxInstallments: num(inst.scheme_sxp_max_installments),
      ...amountsOf(detail),
    };
    const bucket = (out[key] ||= { allowed: false, minAmount: null, frequencies: [], modes: null });
    bucket.frequencies.push(freq);
    if (open) bucket.allowed = true;
    if (!bucket.modes) bucket.modes = modesOfRow(row);
    if (open && freq.minAmount != null) {
      bucket.minAmount = bucket.minAmount == null ? freq.minAmount : Math.min(bucket.minAmount, freq.minAmount);
    }
  }

  return out;
}

/**
 * Compact form for list rows — Explore/Search render badges, not the whole rulebook.
 * `null` still means "BSE did not say", never "no".
 */
function txnSummary(txns = {}) {
  const on = (k) => (txns[k] ? txns[k].allowed === true : null);
  return {
    lumpsum: on("lumpsum"),
    sip: on("sip"),
    swp: on("swp"),
    stp: txns.stpIn || txns.stpOut ? txns.stpIn?.allowed === true || txns.stpOut?.allowed === true : null,
    switchAllowed: txns.switchIn || txns.switchOut ? txns.switchIn?.allowed === true || txns.switchOut?.allowed === true : null,
    redemption: on("redemption"),
  };
}

// BSE sends the number and its unit separately. 0 (or a missing unit) means no lock-in —
// printing "0 days" on a card reads as a restriction that does not exist.
function lockInOf(scheme = {}) {
  const period = num(scheme.scheme_lockin_period);
  if (!period) return null;
  const raw = clean(scheme.scheme_lockin_period_type);
  const unit = /year/i.test(raw) ? "year" : /month/i.test(raw) ? "month" : /day/i.test(raw) ? "day" : "";
  return {
    period,
    type: unit || raw || null,
    label: unit ? `${period} ${unit}${period === 1 ? "" : "s"}` : `${period}${raw ? ` ${raw}` : ""}`,
  };
}

// "IDCW Payout" / "IDCW Reinvestment" / "Growth" — BSE's own scheme_option, normalised so
// the UI can badge it without every page re-inventing the spelling.
function payoutOf(scheme = {}) {
  const opt = clean(scheme.scheme_option);
  if (!opt) return null;
  if (/re-?invest/i.test(opt)) return "IDCW Reinvestment";
  if (/payout|idcw|dividend/i.test(opt)) return "IDCW Payout";
  if (/growth/i.test(opt)) return "Growth";
  return opt;
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

  // ponytail: sirf summary + scalars index mein jate hain. Poori frequency/dates list
  // (4 sxp types × 4 frequencies × ~30 dates) 11k schemes par 40MB+ le jati — wo
  // /scheme-details apne raw row se on-demand banata hai, jahan wo asal mein chahiye.
  const txns = schemeTransactions(scheme);
  const txn = txnSummary(txns);
  const minLumpsum = txns.lumpsum?.minAmount ?? scheme.min_lumpsum_amount ?? scheme.min_amt ?? scheme.minLumpsum;
  const minSip = txns.sip?.minAmount ?? scheme.sip_min_amount ?? scheme.min_sip_amount ?? scheme.minSip;
  const minRedeem = txns.redemption?.minAmount ?? scheme.min_redemption_amount ?? scheme.min_redeem_amt;
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
    // Which transaction types this scheme really accepts — BSE's own lumpsum[]/systematic[]
    // rows, not a guess. Explore/Search badge these; `null` = BSE did not say.
    txn,
    payout: payoutOf(scheme),
    lockIn: lockInOf(scheme),
    benchmark: clean(scheme.scheme_benchmark) || null,
    scheme_amc_name: clean(scheme.scheme_amc_name || scheme.amc_name) || null,
    expense: clean(scheme.expense_ratio || scheme.scheme_expense_ratio || scheme.expense) || null,
    exitLoad: clean(scheme.exit_load || scheme.scheme_exit_load) || null,
    // BSE's master carries no riskometer field (probed: 43 columns, none of them risk).
    // The SEBI risk level is attached later from the enrichment source — see mf/kuvera.js.
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
 * Both forms of every period return, from the same real NAV series.
 *
 * `calcReturnsFromSeries` mixes the two on purpose (1Y absolute, 3Y/5Y annualised) because
 * that is the convention on a fund card. The Absolute/CAGR toggle needs them side by side
 * and unmixed, so this returns each period twice and lets the UI choose.
 *
 * CAGR over a window shorter than a year is annualising noise — a 3% week becomes "365%
 * p.a.". Those are returned as null so the toggle can disable itself instead of printing a
 * number nobody should act on.
 */
const PERIOD_DAYS = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "3Y": 1095, "5Y": 1825, "10Y": 3650 };

function returnsBoth(sorted = []) {
  const absolute = {};
  const cagr = {};
  if (!sorted.length) return { absolute, cagr, inception: null, inceptionDate: null, years: null };

  const last = sorted[sorted.length - 1];
  const first = sorted[0];
  const r2 = (v) => parseFloat(v.toFixed(2));

  for (const [key, days] of Object.entries(PERIOD_DAYS)) {
    const past = navAtOrBefore(sorted, last.timestamp - days * 86400);
    // No NAV that far back = the fund is younger than the window. Saying 0 would be a lie
    // and saying "since inception" under a "5Y" label would be a different lie.
    if (!past || !past.nav || past.timestamp > last.timestamp - days * 86400 * 0.9) {
      absolute[key] = null;
      cagr[key] = null;
      continue;
    }
    const years = (last.timestamp - past.timestamp) / (86400 * 365);
    absolute[key] = r2(((last.nav - past.nav) / past.nav) * 100);
    cagr[key] = years >= 1 ? r2((Math.pow(last.nav / past.nav, 1 / years) - 1) * 100) : null;
  }

  const allYears = (last.timestamp - first.timestamp) / (86400 * 365);
  return {
    absolute,
    cagr,
    inception: first.nav > 0 ? r2(((last.nav - first.nav) / first.nav) * 100) : null,
    inceptionCagr: allYears >= 1 && first.nav > 0 ? r2((Math.pow(last.nav / first.nav, 1 / allYears) - 1) * 100) : null,
    inceptionDate: new Date(first.timestamp * 1000).toISOString().slice(0, 10),
    years: parseFloat(allYears.toFixed(2)),
  };
}

/**
 * Rolling returns: not "what did 3 years give if you entered on one lucky day", but what
 * EVERY 3-year window in this fund's history gave. That distribution is the point — a fund
 * whose best 3Y window is 22% and worst is -4% is a different proposition from one that
 * ranged 11%-13%, and a single trailing number hides exactly that.
 *
 * Windows are stepped weekly, not daily: a daily step on 20 years of NAV is ~5,000 windows
 * per period for a number that moves in the third decimal, and the endpoint is called on
 * every fund page.
 */
function rollingReturns(sorted = [], periods = ["1Y", "3Y", "5Y"], stepDays = 7) {
  const out = {};
  if (sorted.length < 2) return out;
  const last = sorted[sorted.length - 1].timestamp;
  const first = sorted[0].timestamp;

  for (const key of periods) {
    const days = PERIOD_DAYS[key];
    if (!days) continue;
    const span = days * 86400;
    // Not enough history to form even one window — say so rather than return a lonely,
    // meaningless single observation.
    if (last - first < span) {
      out[key] = null;
      continue;
    }
    const years = days / 365;
    const rets = [];
    for (let end = last; end - span >= first; end -= stepDays * 86400) {
      const a = navAtOrBefore(sorted, end - span);
      const b = navAtOrBefore(sorted, end);
      if (!a?.nav || !b?.nav || a.nav <= 0) continue;
      const ratio = b.nav / a.nav;
      rets.push(years >= 1 ? (Math.pow(ratio, 1 / years) - 1) * 100 : (ratio - 1) * 100);
    }
    if (!rets.length) {
      out[key] = null;
      continue;
    }
    rets.sort((x, y) => x - y);
    const r2 = (v) => parseFloat(v.toFixed(2));
    const mid = Math.floor(rets.length / 2);
    out[key] = {
      windows: rets.length,
      annualised: years >= 1,
      average: r2(rets.reduce((s, v) => s + v, 0) / rets.length),
      median: r2(rets.length % 2 ? rets[mid] : (rets[mid - 1] + rets[mid]) / 2),
      min: r2(rets[0]),
      max: r2(rets[rets.length - 1]),
      positivePct: r2((rets.filter((v) => v > 0).length / rets.length) * 100),
    };
  }
  return out;
}

/**
 * Alpha and Beta — measured against the scheme's OWN benchmark, or not at all.
 *
 * The previous implementation invented both: alpha subtracted a hardcoded 0.12 "benchmark
 * return" and beta divided the fund's volatility by a hardcoded 0.16 "market volatility".
 * Beta is covariance with the benchmark over the benchmark's variance — it is not derivable
 * from the fund's own series at any price, which is why those two tiles were removed.
 *
 * With a real benchmark series they come back as measurements. Both are annualised over the
 * overlapping dates only, and the caller is handed `benchmark` + `window` so the number is
 * never shown without saying what it was measured against.
 */
function alphaBeta(fundSeries = [], benchSeries = [], riskFree = RISK_FREE) {
  if (fundSeries.length < 30 || benchSeries.length < 30) return null;

  const bench = new Map(benchSeries.map((p) => [new Date(p.timestamp * 1000).toISOString().slice(0, 10), p.nav]));
  const pairs = [];
  for (const p of fundSeries) {
    const key = new Date(p.timestamp * 1000).toISOString().slice(0, 10);
    const b = bench.get(key);
    if (b > 0 && p.nav > 0) pairs.push({ ts: p.timestamp, f: p.nav, b });
  }
  // A fund and an index that share fewer than ~3 months of dates cannot produce a beta
  // anyone should read; NAV is published on business days only and holidays differ.
  if (pairs.length < 60) return null;

  const fr = [];
  const br = [];
  for (let i = 1; i < pairs.length; i++) {
    fr.push(pairs[i].f / pairs[i - 1].f - 1);
    br.push(pairs[i].b / pairs[i - 1].b - 1);
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mf = mean(fr);
  const mb = mean(br);
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < fr.length; i++) {
    cov += (fr[i] - mf) * (br[i] - mb);
    varB += (br[i] - mb) ** 2;
  }
  if (varB <= 0) return null;
  const beta = cov / varB;
  const annF = mf * TRADING_DAYS;
  const annB = mb * TRADING_DAYS;
  const r2 = (v) => parseFloat(v.toFixed(2));
  return {
    beta: r2(beta),
    // Jensen's alpha: what the fund returned beyond what its beta exposure to the
    // benchmark already explains.
    alpha: r2((annF - (riskFree + beta * (annB - riskFree))) * 100),
    benchmarkReturn: r2(annB * 100),
    riskFreeRate: r2(riskFree * 100),
    days: pairs.length,
    from: new Date(pairs[0].ts * 1000).toISOString().slice(0, 10),
    to: new Date(pairs[pairs.length - 1].ts * 1000).toISOString().slice(0, 10),
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
  // Ranking + filtering (ticket 11). Kept as plain scalars so listCacheKey can key on them
  // — a filter that is not in the cache key would serve another filter's page for 5 minutes.
  const numOrNull = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const risk = String(body.risk || src.risk || "").trim();
  const txn = String(body.txn || src.txn || "").trim().toLowerCase();
  const minAge = numOrNull(body.minAge ?? src.minAge);
  const maxAge = numOrNull(body.maxAge ?? src.maxAge);
  // Ticket 11 — fund-size band, ₹ crore.
  const minAum = numOrNull(body.minAum ?? src.minAum);
  const maxAum = numOrNull(body.maxAum ?? src.maxAum);
  const minReturn = numOrNull(body.minReturn ?? src.minReturn);
  const returnPeriod = String(body.returnPeriod || src.returnPeriod || "1Y").trim().toUpperCase();
  const sort = String(body.sort || src.sort || "").trim().toLowerCase();
  const order = String(body.order || src.order || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
  return {
    start,
    length,
    search,
    category,
    isin,
    scheme_code,
    plan,
    sip,
    mode,
    risk,
    txn,
    minAge,
    maxAge,
    minAum,
    maxAum,
    minReturn,
    returnPeriod,
    sort,
    order,
  };
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
  // Every field parseListQuery can filter or sort on has to appear here. A missing one
  // means two different result sets share a cache entry for five minutes.
  return [
    q.category,
    q.search,
    q.start,
    q.length,
    q.isin,
    q.scheme_code,
    q.plan,
    q.sip,
    q.mode,
    q.risk,
    q.txn,
    q.minAge,
    q.maxAge,
    q.minAum,
    q.maxAum,
    q.minReturn,
    q.returnPeriod,
    q.sort,
    q.order,
  ].join("|");
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
  windowOpenRow,
  allowedModes,
  sipAllowed,
  schemeTransactions,
  txnSummary,
  lockInOf,
  payoutOf,
  returnsBoth,
  rollingReturns,
  alphaBeta,
  PERIOD_DAYS,
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
