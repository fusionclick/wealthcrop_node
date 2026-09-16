/**
 * SCHEME ENRICHMENT — the fields BSE does not publish.
 *
 * BSE StarMF's scheme master is 43 columns and none of them is a riskometer, a fund
 * manager, an investment objective or an inception date (probed live, fields:["ALL"]).
 * AMFI's NAVAll.txt carries prices only. So the SEBI risk badge, the manager and the
 * objective have to come from somewhere else, and this is that somewhere: Kuvera's public
 * fund_schemes API, which is keyed by **the same BSE scheme code we already hold**
 * ("418-GR", "PP001ZG-GR"), so no fuzzy name matching is involved and a hit cannot be a
 * mis-hit.
 *
 * Rules this file lives by:
 *   - fail-open, always. This is decoration on a fund card, never a gate on an order.
 *     Kuvera down => fields come back null and every page still renders.
 *   - one request per scheme, cached hard. The catalogue is 11k schemes; these fields move
 *     monthly at most, so a 24h TTL and a 6h negative TTL keep the traffic to a trickle.
 *   - bounded concurrency. A 100-row page must not open 100 sockets to a third party.
 *
 * `aum` — UNIT NOW VERIFIED (ticket 3). It is scheme-level: the Direct and Regular plans of
 * one scheme return the identical figure.
 *
 * The unit is **₹10 lakh**, i.e. `raw / 10` is the fund size in ₹ crore. That was settled by
 * probing two funds of very different size and checking each against two independent
 * published figures, and it lands exactly, not approximately:
 *
 *   PP001ZG-GR  raw 1,484,290  ->  148,429.0 Cr   published ₹1,48,429 Cr  (ETMoney; and the
 *                                                  mutualfundsindia factsheet, 148,429.00)
 *   SB072SF-DR  raw   921,916  ->   92,191.6 Cr   published ₹92,191.69 Cr (Paytm Money)
 *
 * An earlier reading of this field as ₹1 lakh is what produced the "off by 7-10x" note that
 * used to live here — it was off by exactly 10, which is the whole of the discrepancy.
 *
 * `MF_ENRICH_AUM_DIVISOR` stays overridable so a future feed change can be corrected without
 * a deploy, but it now has a proven default rather than being null-and-hidden.
 */
const axios = require("axios");

const BASE = process.env.MF_ENRICH_URL || "https://api.kuvera.in/mf/api/v5/fund_schemes";
const ENABLED = process.env.MF_ENRICH !== "0";
const TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
const CONCURRENCY = Number(process.env.MF_ENRICH_CONCURRENCY) || 6;
const TIMEOUT_MS = Number(process.env.MF_ENRICH_TIMEOUT_MS) || 6000;
// Verified against published figures — see the note above. Divide the raw value by this to
// get ₹ crore. Set to 0 to withhold AUM entirely again.
const AUM_DIVISOR = process.env.MF_ENRICH_AUM_DIVISOR != null ? Number(process.env.MF_ENRICH_AUM_DIVISOR) : 10;

const http = axios.create({ timeout: TIMEOUT_MS });

/**
 * Raw feed value -> fund size in ₹ crore, or null when it is unusable.
 *
 * A zero or negative AUM is not a fund size, it is a missing one, and showing "₹0 Cr" next
 * to a fund people are about to buy would read as a real and alarming number.
 */
function aumCrore(raw) {
  if (!(AUM_DIVISOR > 0)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / AUM_DIVISOR) * 100) / 100;
}

/**
 * SEBI's riskometer has exactly six levels. Anything that does not map to one of them is
 * null — never the nearest neighbour. A fund badged "Moderate" that is actually "Very High"
 * is the single most damaging thing this file could do.
 */
const RISK_LEVELS = ["Low", "Low to Moderate", "Moderate", "Moderately High", "High", "Very High"];
const RISK_RANK = new Map(RISK_LEVELS.map((r, i) => [r, i + 1]));

function normaliseRisk(raw) {
  const s = String(raw || "")
    .replace(/\brisk\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === "low to moderate" || s === "low to moderately high") return "Low to Moderate";
  if (s === "moderately high") return "Moderately High";
  if (s === "very high") return "Very High";
  if (s === "low") return "Low";
  if (s === "moderate") return "Moderate";
  if (s === "high") return "High";
  return null;
}

const str = (v) => {
  const s = String(v ?? "").trim();
  return s && !/^(na|n\/a|null|-)$/i.test(s) ? s : null;
};

const pct = (v) => {
  const n = Number(v);
  // Kuvera sends 0 for "not available" on funds younger than the window (a genuine 0.00%
  // return over three years does not happen), and the fund list would then rank a new fund
  // as a flat performer instead of an unknown one.
  return Number.isFinite(n) && n !== 0 ? parseFloat(n.toFixed(2)) : null;
};

function shape(row = {}) {
  const inception = str(row.start_date);
  const r = row.returns || {};
  const ageYears =
    inception && !Number.isNaN(Date.parse(inception))
      ? parseFloat(((Date.now() - Date.parse(inception)) / (365.25 * 24 * 3600 * 1000)).toFixed(1))
      : null;
  return {
    risk: normaliseRisk(row.crisil_rating),
    riskRank: RISK_RANK.get(normaliseRisk(row.crisil_rating)) || null,
    // Kuvera returns co-managers separated by "; ".
    fundManagers: str(row.fund_manager)
      ? String(row.fund_manager)
          .split(/\s*;\s*/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    objective: str(row.investment_objective),
    factsheetUrl: str(row.detail_info),
    expense: str(row.expense_ratio),
    expenseAsOf: str(row.expense_ratio_date),
    // "Plan inception", not "fund inception": for a scheme that predates 2013 the direct
    // plan legitimately starts 2013-01-01, and labelling that as the fund's birthday would
    // be wrong. The UI says plan.
    inceptionDate: inception,
    ageYears,
    fundRating: row.fund_rating != null ? Number(row.fund_rating) : null,
    fundRatingAsOf: str(row.fund_rating_date),
    // Trailing returns for the LIST: this is what makes "rank by 3Y return" possible across
    // 11k schemes without 11k NAV-history downloads. The fund DETAIL page keeps computing
    // its own numbers from the real NAV series (mfapi) — that is the authoritative one, and
    // the two can differ in the second decimal because they are cut on different days.
    returns: { "1Y": pct(r.year_1), "3Y": pct(r.year_3), "5Y": pct(r.year_5), inception: pct(r.inception) },
    volatility: pct(row.volatility),
    // Always ₹ crore by the time it leaves this file, so no caller has to know the feed's
    // unit — the mistake this field already made once.
    aum: aumCrore(row.aum),
    aumUnit: AUM_DIVISOR > 0 ? "crore" : null,
  };
}

const cache = new Map();
const inFlight = new Map();
let active = 0;
const queue = [];

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    job().finally(() => {
      active--;
      pump();
    });
  }
}

function schedule(fn) {
  return new Promise((resolve) => {
    queue.push(() => fn().then(resolve, () => resolve(null)));
    pump();
  });
}

async function fetchScheme(code) {
  const { data } = await http.get(`${BASE}/${encodeURIComponent(code)}.json`);
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? shape(row) : null;
}

/** Enrichment for one BSE scheme code. Never throws; null means "we do not know". */
async function getEnrichment(bseCode) {
  const code = String(bseCode || "").trim();
  if (!ENABLED || !code) return null;

  const hit = cache.get(code);
  if (hit && Date.now() < hit.exp) return hit.data;
  if (inFlight.has(code)) return inFlight.get(code);

  const p = schedule(() => fetchScheme(code))
    .then((data) => {
      cache.set(code, { data, exp: Date.now() + (data ? TTL_MS : MISS_TTL_MS) });
      return data;
    })
    .catch((err) => {
      // Negative-cache the failure too, otherwise an outage turns every page load into
      // another 20 doomed requests.
      cache.set(code, { data: null, exp: Date.now() + MISS_TTL_MS });
      if (!getEnrichment.warned) {
        console.warn("[mf] scheme enrichment unavailable:", err.message);
        getEnrichment.warned = true;
      }
      return null;
    })
    .finally(() => inFlight.delete(code));

  inFlight.set(code, p);
  return p;
}

/**
 * Attach enrichment to the rows of ONE page.
 *
 * Deliberately page-scoped, exactly like admin_category: these fields change far more often
 * than the 6-hourly master index, and enriching all 11k rows up front would mean 11k
 * third-party requests before the first fund list could render.
 */
// How long a fund list is willing to wait on the enrichment source before rendering
// without it. Same principle as the catalogue's COLD_WAIT_MS: the first visitor after a
// deploy must not pay for a cold cache. Whatever lands after the deadline is still cached,
// so the next request has it.
const PAGE_WAIT_MS = Number(process.env.MF_ENRICH_PAGE_WAIT_MS) || 800;

async function enrichRows(rows = []) {
  if (!ENABLED || !rows.length) return rows;

  const pending = rows.map((r) => getEnrichment(r.scheme_bse_code));
  const deadline = new Promise((resolve) => setTimeout(resolve, PAGE_WAIT_MS).unref?.());
  await Promise.race([Promise.all(pending), deadline]);

  // Read from the cache rather than from the promises: the ones that finished are there,
  // the ones still in flight simply are not, and nothing is awaited a second time.
  return rows.map((row) => {
    const extra = peekEnrichment(row.scheme_bse_code);
    if (!extra) return { ...row, enriched: false };
    return {
      ...row,
      enriched: true,
      // BSE wins wherever BSE actually has the field; this only fills the gaps.
      risk: row.risk || extra.risk,
      riskRank: extra.riskRank,
      expense: row.expense || extra.expense,
      fundManagers: extra.fundManagers,
      objective: extra.objective,
      factsheetUrl: extra.factsheetUrl,
      inceptionDate: extra.inceptionDate,
      ageYears: extra.ageYears,
      fundRating: extra.fundRating,
      aum: extra.aum,
      aumUnit: extra.aumUnit,
      returns: extra.returns || row.returns,
    };
  });
}

/**
 * Copy whatever enrichment is already cached onto an index row, in place.
 *
 * The master index is rebuilt from BSE every 6 hours and mapScheme cannot know any of these
 * fields, so without this the risk badge and the returns would vanish from the catalogue
 * for the length of a rebuild — and, worse, the risk/returns FILTERS would quietly start
 * matching nothing. The enrichment cache outlives the index, so a rebuild re-attaches for
 * free.
 */
function applyCached(row) {
  const extra = peekEnrichment(row?.scheme_bse_code);
  if (!extra) return false;
  row.risk = row.risk || extra.risk;
  row.riskRank = extra.riskRank;
  row.ageYears = extra.ageYears;
  row.inceptionDate = extra.inceptionDate;
  row.fundRating = extra.fundRating;
  row.returns = extra.returns || row.returns;
  row.enriched = true;
  return true;
}

/**
 * Fill the enrichment cache for the WHOLE catalogue, slowly, in the background.
 *
 * Why it has to exist: the client asked for a risk badge on every card and for filtering and
 * ranking by risk / fund age / returns ACROSS the catalogue. Filtering happens over all
 * ~11k mapped rows before the page is sliced (that is what makes `total` honest), so the
 * fields have to be ON those rows — a per-page fetch can only decorate the 20 rows already
 * chosen, which is too late to filter by.
 *
 * Why it is slow on purpose: this is someone else's free API. RATE is requests per second,
 * not a concurrency knob, and the whole sweep is a once-a-day cost because the per-scheme
 * TTL is 24h. Everything it touches is fail-open, so a block or an outage costs badges and
 * filters, never a page.
 */
const WARM_ENABLED = process.env.MF_ENRICH_WARM !== "0";
const WARM_RATE = Number(process.env.MF_ENRICH_WARM_RATE) || 3;
let warming = false;

async function warmEnrichment(rows = [], { rate = WARM_RATE } = {}) {
  if (!ENABLED || !WARM_ENABLED || warming || !rows.length) return null;
  warming = true;
  const t0 = Date.now();
  let fetched = 0;
  let reused = 0;
  const gap = Math.max(0, Math.floor(1000 / Math.max(1, rate)));

  try {
    for (const row of rows) {
      if (applyCached(row)) {
        reused++;
        continue;
      }
      await getEnrichment(row.scheme_bse_code);
      applyCached(row);
      fetched++;
      if (gap) await new Promise((r) => setTimeout(r, gap).unref?.());
    }
    const stats = enrichmentStats();
    console.log(
      `[mf] enrichment warm: ${fetched} fetched, ${reused} cached, ${stats.known} known / ${stats.missing} unknown in ${Math.round(
        (Date.now() - t0) / 1000
      )}s`
    );
    return stats;
  } finally {
    warming = false;
  }
}

/** Cached-only read, for code paths that must not wait on the network (filters). */
function peekEnrichment(bseCode) {
  const hit = cache.get(String(bseCode || "").trim());
  return hit && Date.now() < hit.exp ? hit.data : undefined;
}

function enrichmentStats() {
  let known = 0;
  let missing = 0;
  for (const { data } of cache.values()) (data ? known++ : missing++);
  return { cached: cache.size, known, missing, queued: queue.length, active };
}

function resetEnrichmentCache(seed = null) {
  cache.clear();
  inFlight.clear();
  if (seed) for (const [code, data] of Object.entries(seed)) cache.set(code, { data, exp: Date.now() + TTL_MS });
}

module.exports = {
  getEnrichment,
  enrichRows,
  warmEnrichment,
  applyCached,
  peekEnrichment,
  enrichmentStats,
  resetEnrichmentCache,
  normaliseRisk,
  aumCrore,
  RISK_LEVELS,
  RISK_RANK,
};
