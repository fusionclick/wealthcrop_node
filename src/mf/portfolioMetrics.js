/**
 * Audit #62 — risk and return for the investor's whole fund portfolio, not one scheme.
 *
 * The full metric set (volatility, Sharpe, Sortino, max drawdown, VaR, alpha/beta) already
 * existed per scheme in scheme.js. A portfolio has no NAV of its own, so this builds one:
 * today's units in each fund × that fund's NAV history, summed per day — the value the
 * CURRENT holdings would have had. That is how a portfolio's risk is normally read (it is
 * what the money is exposed to now). It is NOT the investor's realised return; XIRR on the
 * dashboard already reports that, from their real cash flows.
 *
 * The statistics are scheme.js's own functions, imported — not a second copy that could
 * drift from the fund page.
 */
const { ratiosFromSeries, alphaBeta, fundProfile } = require("./scheme");
const { loadFundNav } = require("./mfapi");
const { benchmarkSeries } = require("./benchmark");
const { getHoldings } = require("./holdings");

const DAY = 86400;
const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/**
 * Σ units × NAV per day, oldest first, over the window in which EVERY fund has a NAV: before
 * the youngest fund existed the "portfolio" would be a different one. A fund's last NAV is
 * carried across its own holidays, so one AMC skipping a day does not dent the total.
 *
 * @param {Array<{units:number, series:Array<{timestamp:number, nav:number}>}>} legs
 * @param {number} days how far back to look
 * @returns {Array<{timestamp:number, nav:number}>} nav is the portfolio's value that day
 */
function portfolioSeries(legs = [], days = 400) {
  const usable = legs.filter((l) => Number(l.units) > 0 && Array.isArray(l.series) && l.series.length);
  if (!usable.length) return [];

  const sorted = usable.map((l) => ({ units: Number(l.units), series: [...l.series].sort((a, b) => a.timestamp - b.timestamp) }));
  const end = Math.max(...sorted.map((l) => l.series[l.series.length - 1].timestamp));
  const start = Math.max(end - days * DAY, ...sorted.map((l) => l.series[0].timestamp));

  // Every date any fund published, in the window.
  const dates = [...new Set(sorted.flatMap((l) => l.series.filter((p) => p.timestamp >= start).map((p) => dayOf(p.timestamp))))].sort();

  const cursors = sorted.map(() => 0);
  const last = sorted.map(() => null);
  const out = [];
  for (const date of dates) {
    let value = 0;
    let complete = true;
    sorted.forEach((leg, i) => {
      while (cursors[i] < leg.series.length && dayOf(leg.series[cursors[i]].timestamp) <= date) {
        last[i] = leg.series[cursors[i]].nav;
        cursors[i]++;
      }
      if (!(last[i] > 0)) complete = false;
      else value += leg.units * last[i];
    });
    if (complete) out.push({ timestamp: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000), nav: value });
  }
  return out;
}

/** Each sector's share of the funds that disclosed one, weighted by what is held in each. */
function sectorAllocation(legs = []) {
  const total = legs.reduce((a, l) => a + l.value, 0);
  const covered = legs.filter((l) => l.sectors.length);
  const coveredValue = covered.reduce((a, l) => a + l.value, 0);
  if (!coveredValue) return { rows: [], coveragePct: 0 };

  const by = new Map();
  for (const leg of covered) {
    const weight = leg.value / coveredValue;
    for (const s of leg.sectors) by.set(s.name, (by.get(s.name) || 0) + (Number(s.pct) || 0) * weight);
  }
  const r2 = (v) => parseFloat(v.toFixed(2));
  return {
    rows: [...by.entries()].map(([name, pct]) => ({ name, pct: r2(pct) })).sort((a, b) => b.pct - a.pct),
    coveragePct: r2((coveredValue / total) * 100),
  };
}

/**
 * @param {Array<{isin?:string, scheme_code?:string, name?:string, units:number}>} holdings
 * @param {object} deps injectable for tests: load(isin, name), bench(name), disclosure(isin, code)
 */
async function portfolioMetrics(holdings = [], { load = loadFundNav, bench = benchmarkSeries, disclosure = getHoldings } = {}) {
  const legs = [];
  const skipped = [];

  for (const h of holdings) {
    const units = Number(h?.units) || 0;
    if (units <= 0) continue;
    const name = h.name || h.isin || h.scheme_code || "Fund";
    // Priced by ISIN, like every other valuation on the investments page.
    if (!h.isin) {
      skipped.push({ name, reason: "No ISIN to price it by" });
      continue;
    }
    let mf = null;
    try {
      mf = await load(h.isin, h.name);
    } catch {
      mf = null;
    }
    const series = mf?.series || [];
    if (series.length < 30) {
      skipped.push({ name, reason: "No NAV history" });
      continue;
    }
    let sectors = [];
    try {
      sectors = fundProfile(await disclosure(h.isin, h.scheme_code)).sectors || [];
    } catch {
      sectors = [];
    }
    legs.push({ name, units, series, value: units * series[series.length - 1].nav, sectors });
  }

  const series = portfolioSeries(legs);
  const ratios = series.length > 21 ? ratiosFromSeries(series) : {};
  if (!ratios.window) {
    return { metrics: null, skipped, sectors: sectorAllocation(legs), reason: legs.length ? "Not enough shared NAV history yet" : "No fund could be priced" };
  }

  // Annualised return over the same window the ratios were measured on.
  const window = series.slice(-(ratios.window + 1));
  const first = window[0];
  const lastPoint = window[window.length - 1];
  const years = (lastPoint.timestamp - first.timestamp) / (365 * DAY);
  const r2 = (v) => parseFloat(v.toFixed(2));
  const annualisedReturn = years >= 0.5 && first.nav > 0 ? r2((Math.pow(lastPoint.nav / first.nav, 1 / years) - 1) * 100) : null;

  // Beta against the Nifty 50 for the whole portfolio — the market the brief measures it by,
  // not each fund's own benchmark. A price index, said so on the screen.
  let risk = null;
  try {
    const b = await bench("Nifty 50");
    const ab = b ? alphaBeta(series, b.series) : null;
    if (ab) risk = { beta: ab.beta, alpha: ab.alpha, benchmarkReturn: ab.benchmarkReturn, benchmark: b.label, benchmarkIsPriceIndex: !!b.isPriceIndex };
  } catch {
    risk = null;
  }

  return {
    metrics: {
      annualisedReturn,
      volatility: ratios.volatility,
      sharpe: ratios.sharpe,
      sortino: ratios.sortino,
      maxDrawdown: ratios.maxDrawdown,
      var95: ratios.var95,
      riskFreeRate: ratios.riskFreeRate,
      beta: risk?.beta ?? null,
      alpha: risk?.alpha ?? null,
      benchmark: risk?.benchmark ?? "Nifty 50",
      benchmarkReturn: risk?.benchmarkReturn ?? null,
      benchmarkIsPriceIndex: risk?.benchmarkIsPriceIndex ?? true,
      from: dayOf(first.timestamp),
      to: dayOf(lastPoint.timestamp),
      tradingDays: ratios.window,
      funds: legs.length,
    },
    skipped,
    sectors: sectorAllocation(legs),
  };
}

/** POST /portfolio-metrics  { holdings: [{ isin, scheme_code, name, units }] } — the investor's own. */
async function portfolioMetricsHandler(req, res) {
  const holdings = Array.isArray(req.body?.holdings) ? req.body.holdings.slice(0, 100) : [];
  try {
    return res.json({ status: "success", data: await portfolioMetrics(holdings) });
  } catch (e) {
    console.error("[mf] portfolio metrics failed:", e.message);
    return res.status(500).json({ status: "error", message: "Portfolio metrics are unavailable right now." });
  }
}

module.exports = { portfolioSeries, sectorAllocation, portfolioMetrics, portfolioMetricsHandler };
