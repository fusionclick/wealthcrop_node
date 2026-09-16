/**
 * BENCHMARK PRICE SERIES — the missing half of Alpha and Beta.
 *
 * Beta is the fund's covariance with its benchmark over the benchmark's variance, and
 * Jensen's alpha is what the fund returned beyond what that beta already explains. Neither
 * can be derived from the fund's own NAV history, which is why both tiles were removed
 * earlier (the old code faked them with a hardcoded 0.12 "benchmark return" and a hardcoded
 * 0.16 "market volatility").
 *
 * BSE does give us the one thing that was missing: `scheme_benchmark`, the index the AMC
 * itself measures against. This file turns that string into a real price series.
 *
 * Two deliberate limits:
 *   - Only indices we can name with certainty are mapped. An unrecognised benchmark returns
 *     null and the fund page simply has no Alpha/Beta — guessing "close enough, use Nifty
 *     50" would put a number under a label it does not belong to.
 *   - Yahoo serves PRICE indices; most benchmarks in a factsheet are TRI (dividends
 *     reinvested). Beta is barely affected, alpha is (TRI runs ~1-1.5% p.a. higher), so the
 *     API hands back `benchmarkIsPriceIndex: true` and the UI says so under the number.
 */
const axios = require("axios");

const http = axios.create({
  timeout: Number(process.env.MF_BENCHMARK_TIMEOUT_MS) || 8000,
  headers: { "User-Agent": "Mozilla/5.0" },
});
const ENABLED = process.env.MF_BENCHMARK !== "0";
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Ordered: the first pattern that matches wins, so narrower indices are tested before the
 * broad ones ("NIFTY MIDCAP 150" must not be eaten by /NIFTY/).
 */
const INDEX_MAP = [
  [/nifty\s*bank|bank\s*nifty/i, "^NSEBANK", "Nifty Bank"],
  [/nifty\s*next\s*50/i, "^NSMIDCP", "Nifty Next 50"],
  [/nifty\s*midcap\s*50/i, "^NSEMDCP50", "Nifty Midcap 50"],
  [/nifty\s*100/i, "^CNX100", "Nifty 100"],
  [/nifty\s*500/i, "^CRSLDX", "Nifty 500"],
  [/nifty\s*50/i, "^NSEI", "Nifty 50"],
  [/(s&p\s*)?bse\s*sensex|^sensex/i, "^BSESN", "S&P BSE Sensex"],
];

/**
 * Ticket 5 — Alpha and Beta when the scheme does not name its own benchmark.
 *
 * `scheme_benchmark` is a real BSE column, but it comes back empty for every scheme on the
 * host this platform is pointed at, so Alpha and Beta never appeared at all. The fallback is
 * the benchmark SEBI prescribes for the scheme's category — the same index the AMC's own
 * factsheet measures against, not a guess.
 *
 * Two rules keep it honest:
 *   - Only indices verified to return a full daily series are mapped. Nifty Midcap 150 and
 *     Smallcap 250 — the exact Tier-1 benchmarks for those categories — are not published by
 *     the price source, so mid cap falls back to Midcap 50 and SMALL CAP GETS NOTHING rather
 *     than being measured against an index it does not track.
 *   - The caller is told which index by name, and that it came from the category, so the page
 *     says "vs Nifty 500" rather than an unqualified "Beta". A number under a label it does
 *     not belong to is the thing this file exists to prevent.
 *
 * Debt, liquid, hybrid, gold and international get nothing: their benchmarks are debt or
 * blended indices this source does not carry, and an equity index would be meaningless.
 */
const CATEGORY_BENCHMARKS = [
  [/small\s*cap/i, null], // Tier-1 is Smallcap 250 — unavailable, so no number at all.
  [/large\s*(?:&|and)\s*mid|large\s*mid/i, "Nifty 500"],
  [/mid\s*cap/i, "Nifty Midcap 50"],
  [/large\s*cap|bluechip|top\s*100/i, "Nifty 100"],
  [/bank|financial\s*services/i, "Nifty Bank"],
  [/flexi\s*cap|multi\s*cap|focus|value|contra|elss|tax\s*saver|dividend\s*yield|equity/i, "Nifty 500"],
];

/**
 * Which benchmark a scheme should be measured against, and where it came from.
 *
 * The scheme's OWN benchmark always wins. BSE publishes it as `scheme_benchmark` — a real
 * column, currently empty on the host this platform reaches, which is the only reason the
 * category fallback exists. The day a host that populates it is connected, every scheme
 * silently upgrades from the category index to the one its AMC actually named, with no code
 * change; this function is where that precedence lives so it can be tested rather than
 * assumed.
 */
function benchmarkFor(scheme = {}) {
  const own = String(scheme.benchmark || "").trim();
  if (own) return { name: own, source: "scheme" };

  const inferred = categoryBenchmark(scheme.category, scheme.subType, scheme.name);
  return inferred ? { name: inferred, source: "category" } : { name: null, source: null };
}

/** Benchmark name inferred from a scheme's category, or null when there is no usable index. */
function categoryBenchmark(...hints) {
  const text = hints.filter(Boolean).join(" ");
  if (!text.trim()) return null;
  // Debt-ish and blended categories first — they must not fall through to the /equity/ arm.
  if (/debt|liquid|overnight|money\s*market|gilt|bond|credit|duration|hybrid|balanced|arbitrage|gold|silver|international|global|fund\s*of\s*fund|\bfof\b/i.test(text)) {
    return null;
  }
  const hit = CATEGORY_BENCHMARKS.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

function resolveBenchmark(name) {
  const s = String(name || "").trim();
  if (!s) return null;
  const hit = INDEX_MAP.find(([re]) => re.test(s));
  if (!hit) return null;
  return { symbol: hit[1], label: hit[2], raw: s, isPriceIndex: true };
}

const cache = new Map();

async function fetchSeries(symbol, range = "10y") {
  const key = `${symbol}:${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.data;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const { data } = await http.get(url, { params: { range, interval: "1d" } });
  const r = data?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const close = r?.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    const nav = Number(close[i]);
    // Yahoo pads holidays with nulls; a null close is not a zero price.
    if (ts[i] && Number.isFinite(nav) && nav > 0) series.push({ timestamp: ts[i], nav });
  }
  cache.set(key, { data: series, exp: Date.now() + TTL_MS });
  return series;
}

/** Benchmark series for a scheme's benchmark string. Never throws; null = unavailable. */
async function benchmarkSeries(benchmarkName, range = "10y") {
  if (!ENABLED) return null;
  const meta = resolveBenchmark(benchmarkName);
  if (!meta) return null;
  try {
    const series = await fetchSeries(meta.symbol, range);
    return series.length ? { ...meta, series } : null;
  } catch (err) {
    console.warn("[mf] benchmark series unavailable:", meta.symbol, err.message);
    return null;
  }
}

function resetBenchmarkCache(seed = null) {
  cache.clear();
  if (seed) for (const [k, v] of Object.entries(seed)) cache.set(k, { data: v, exp: Date.now() + TTL_MS });
}

module.exports = { resolveBenchmark, benchmarkSeries, categoryBenchmark, benchmarkFor, resetBenchmarkCache, INDEX_MAP, CATEGORY_BENCHMARKS };
