const axios = require("axios");
const { parseNavRows, calcReturnsFromSeries, chartFromSeries, avgReturns, rankInPeers } = require("./scheme");

const http = axios.create({ timeout: 20000 });
const cache = new Map();

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.data;
  return fn().then((data) => {
    cache.set(key, { data, exp: Date.now() + ttl });
    return data;
  });
}

function searchQuery(name = "", isin = "") {
  const stop = /^(the|and|plan|fund|scheme|direct|regular|growth|idcw|option)$/i;
  const words = String(name)
    .replace(/[-()/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.test(w));
  return words.slice(0, 6).join(" ") || String(isin || "").trim();
}

async function searchSchemes(q) {
  if (!q) return [];
  return cached(`s:${q}`, 6 * 3600 * 1000, async () => {
    const { data } = await http.get("https://api.mfapi.in/mf/search", { params: { q } });
    return Array.isArray(data) ? data : [];
  });
}

async function getLatest(code) {
  return cached(`l:${code}`, 6 * 3600 * 1000, async () => {
    const { data } = await http.get(`https://api.mfapi.in/mf/${code}/latest`);
    return data || {};
  });
}

async function getHistory(code) {
  return cached(`h:${code}`, 6 * 3600 * 1000, async () => {
    const { data } = await http.get(`https://api.mfapi.in/mf/${code}`);
    return data || {};
  });
}

async function resolveScheme(isin, name) {
  const needle = String(isin || "").trim().toUpperCase();
  const q = searchQuery(name, isin);
  const hits = await searchSchemes(q);
  for (const h of hits.slice(0, 12)) {
    const latest = await getLatest(h.schemeCode);
    const meta = latest.meta || {};
    const isins = [meta.isin_growth, meta.isin_div_reinvestment].map((x) => String(x || "").toUpperCase());
    if (needle && isins.includes(needle)) return { code: h.schemeCode, meta, latest };
  }
  if (!hits[0]) return null;
  const latest = await getLatest(hits[0].schemeCode);
  return { code: hits[0].schemeCode, meta: latest.meta || {}, latest };
}

async function loadFundNav(isin, name) {
  const resolved = await resolveScheme(isin, name);
  if (!resolved) return null;
  const hist = await getHistory(resolved.code);
  const series = parseNavRows(hist.data || []);
  const returns = calcReturnsFromSeries(series);
  const chartData = chartFromSeries(series);
  const currentNav = series.length ? series[series.length - 1].nav : parseFloat(resolved.latest?.data?.[0]?.nav || 0) || null;
  return { ...resolved, series, returns, chartData, currentNav };
}

async function peerReturns(query, selfCode, limit = 5) {
  const hits = (await searchSchemes(query)).filter((h) => h.schemeCode !== selfCode).slice(0, limit);
  const rows = [];
  for (const h of hits) {
    try {
      const hist = await getHistory(h.schemeCode);
      rows.push(calcReturnsFromSeries(parseNavRows(hist.data || [])));
    } catch {
      /* skip peer */
    }
  }
  return rows;
}

async function categoryStats(query, selfCode, selfReturns) {
  const peers = await peerReturns(query, selfCode, 5);
  const all = selfReturns ? [selfReturns, ...peers] : peers;
  return {
    categoryAvg: avgReturns(all),
    rank: {
      "1Y": rankInPeers(selfReturns?.["1Y"], all, "1Y"),
      "3Y": rankInPeers(selfReturns?.["3Y"], all, "3Y"),
      "5Y": rankInPeers(selfReturns?.["5Y"], all, "5Y"),
      ALL: rankInPeers(selfReturns?.ALL, all, "ALL"),
    },
  };
}

module.exports = { searchQuery, resolveScheme, loadFundNav, categoryStats };
