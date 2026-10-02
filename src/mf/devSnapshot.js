/**
 * DEV-ONLY CATALOGUE SNAPSHOT — so the fund screens can be shown on a machine BSE will not
 * talk to.
 *
 * BSE StarMF is IP-whitelisted to the production box. Locally the catalogue falls back to
 * AMFI's NAV file (MF_AMFI_FALLBACK), whose rows carry no BSE flags, minimums, holding modes
 * or SIP/SWP/STP rules — so the default physical filter returns nothing and every attribute
 * the client asked to see reads blank. This replays a read-only copy of what the live site
 * already serves to anonymous visitors: the same `POST /api/bse/master-scheme-list` and
 * `/scheme-details` requests its own Explore and fund pages make (no login, no writes; the
 * list endpoint has no GET form).
 *
 * Inert unless MF_DEV_CATALOGUE_SNAPSHOT names the snapshot file, and inert under
 * NODE_ENV=production whatever that variable says (the Dockerfile sets production). Never
 * set it on a server: it replaces BSE as the catalogue source.
 *
 * Build or refresh the file (from the Backend folder):
 *   node src/mf/devSnapshot.js [out-file] [--lumpsum-floor N] [--sip-floor N]
 * A floor is the live platform's own admin minimum (admin panel → Settings). The live list
 * serves every minimum already raised to it, so a value equal to the floor says nothing about
 * BSE's own figure and is stored as unknown (null) instead — this file must never present the
 * platform's rule as the exchange's. On 2026-10-02 every one of the 11,051 live rows read
 * ₹25,000 lumpsum or more and none read under ₹500 SIP, so the snapshot was taken with
 * `--lumpsum-floor 25000 --sip-floor 500`.
 */
const fs = require("fs");
const path = require("path");
const { pickScheme } = require("./scheme");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_FILE = path.join(ROOT, ".cache", "catalogue-snapshot.json");
const BASE = "https://wealthcrop.co.in/api/bse";

const setting = () => String(process.env.MF_DEV_CATALOGUE_SNAPSHOT || "").trim();
const enabled = () => Boolean(setting()) && process.env.NODE_ENV !== "production";

let loaded = null;

function load() {
  if (!enabled()) return null;
  const file = path.resolve(ROOT, setting());
  if (loaded?.file === file) return loaded.data;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
    // Every row under each of its keys: one ISIN can carry two live codes (an IDCW payout and
    // a reinvestment option), and pickScheme chooses between them exactly as for BSE.
    const byKey = new Map();
    for (const row of data.lists || []) {
      for (const k of [row.scheme_isin, row.scheme_bse_code]) {
        const key = String(k || "").trim().toUpperCase();
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(row);
      }
    }
    data.byKey = byKey;
    console.warn(
      `[mf] DEV catalogue snapshot ACTIVE — ${data.lists.length} schemes from ${file} (taken ${data.takenAt}). Never set MF_DEV_CATALOGUE_SNAPSHOT on a server.`
    );
  } catch (err) {
    console.error(`[mf] MF_DEV_CATALOGUE_SNAPSHOT is set but ${file} could not be read:`, err.message);
    data = null;
  }
  loaded = { file, data };
  return data;
}

/** The snapshot as a master index (catalogue.js shape), or null when the snapshot is off. */
function snapshotMaster() {
  const data = load();
  if (!data?.lists?.length) return null;
  // `at: Infinity` keeps it "fresh" for ever — a rebuild would only be a BSE timeout here.
  return { at: Infinity, list: data.lists, fields: Object.keys(data.lists[0]) };
}

/**
 * One scheme out of the snapshot — by ISIN, exact BSE code and payout option, the same way
 * /scheme-details picks among BSE's rows — with, for the schemes whose fund page was
 * captured, BSE's per-transaction rulebook. Copies, so a caller flooring minimums in place
 * cannot change the snapshot.
 */
function snapshotScheme(isin, code, option) {
  const data = load();
  if (!data) return null;
  const key = (v) => String(v || "").trim().toUpperCase();
  const candidates = [...(data.byKey.get(key(code)) || []), ...(data.byKey.get(key(isin)) || [])];
  if (!candidates.length) return null;
  const row = pickScheme(candidates, isin, code, option);
  const txns = data.details?.[row.scheme_bse_code]?.transactions;
  return { row: structuredClone(row), transactions: structuredClone(txns || {}) };
}

/* ---------------------------------------------------------------- builder (CLI only) --- */

// Fund pages captured with their full rulebook: one per category the client's checklist
// talks about, plus the first page Explore opens on, so whatever is clicked on camera has it.
// Regular plans: the only ones a distributor may offer (Compliance #31), so the only ones a
// demo buys.
const regularGrowth = (f) => f.plan === "Regular" && f.payout === "Growth";
const PICKS = [
  (f) => f.scheme_isin === "INF879O01019", // Parag Parikh Flexi Cap, Regular Growth
  (f) => /\belss\b/i.test(f.subType) && regularGrowth(f),
  (f) => /small cap/i.test(f.subType) && regularGrowth(f),
  (f) => /\bmid cap/i.test(f.subType) && !/large/i.test(f.subType) && regularGrowth(f),
  (f) => /large cap/i.test(f.subType) && regularGrowth(f),
  (f) => /liquid/i.test(`${f.category} ${f.subType}`) && regularGrowth(f),
  (f) => /\bgold\b/i.test(f.name) && regularGrowth(f),
  (f) => /international|overseas|global innovation|nasdaq|us equity/i.test(f.name) && regularGrowth(f),
  (f) => /hybrid/i.test(f.category) && regularGrowth(f),
  (f) => /index/i.test(`${f.category} ${f.subType}`) && /nifty 50 index/i.test(f.name) && regularGrowth(f),
  (f) => /technolog|digital/i.test(f.name) && regularGrowth(f),
  (f) => /pharma/i.test(f.name) && regularGrowth(f),
  (f) => /banking|financial services/i.test(f.name) && /equity/i.test(f.category) && regularGrowth(f),
  (f) => f.payout === "IDCW Payout" && f.txn?.swp === true && f.plan === "Regular",
  (f) => f.payout === "IDCW Reinvestment" && f.plan === "Regular",
  (f) => f.sip_allowed === false && f.plan === "Regular",
  (f) => f.sip_allowed === true && f.txn?.swp !== true && f.plan === "Regular",
  // History-length demos (rolling returns, chart ranges) need no purchase, so any plan.
  (f) => f.ageYears != null && f.ageYears < 1,
  (f) => f.ageYears >= 3.2 && f.ageYears < 4.5 && f.plan === "Regular",
];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const unfloor = (v, floor) => (floor && Number(v) === floor ? null : v);

async function build(out = DEFAULT_FILE, { base = BASE, lumpsumFloor = 0, sipFloor = 0 } = {}) {
  const lists = [];
  for (let start = 0; ; start += 100) {
    const res = await post(`${base}/master-scheme-list`, { start, length: 100 });
    if (res?.data?.warming) throw new Error("the live catalogue is still warming up — try again in a few minutes");
    const rows = res?.data?.lists || [];
    lists.push(...rows);
    process.stdout.write(`\r  catalogue ${lists.length}/${res?.data?.total}`);
    if (!rows.length || lists.length >= Number(res?.data?.total)) break;
    await pause(250);
  }
  process.stdout.write("\n");

  lists.forEach((row, i) => {
    row.id = i + 1;
    row.minLumpsum = unfloor(row.minLumpsum, lumpsumFloor);
    row.minSip = unfloor(row.minSip, sipFloor);
  });

  // The page Explore opens on: physical (the platform default) and Regular (Compliance #31).
  const exploreFirst = lists.filter((f) => f.holding_modes?.physical === true && f.plan === "Regular").slice(0, 20);
  const picked = new Set(exploreFirst);
  for (const pick of PICKS) {
    const hit = lists.find((f) => pick(f) && f.enriched !== false) || lists.find(pick);
    if (hit) picked.add(hit);
  }

  const details = {};
  for (const f of picked) {
    try {
      // The code alone: with the ISIN too, the live server may answer for the sibling option
      // that shares it.
      const res = await post(`${base}/scheme-details`, { scheme_code: f.scheme_bse_code });
      const t = res?.data?.transactions;
      if (!t) continue;
      if (t.lumpsum) t.lumpsum.minAmount = unfloor(t.lumpsum.minAmount, lumpsumFloor);
      if (t.sip) {
        t.sip.minAmount = unfloor(t.sip.minAmount, sipFloor);
        for (const freq of t.sip.frequencies || []) freq.minAmount = unfloor(freq.minAmount, sipFloor);
      }
      // Keyed by BSE code: an ISIN can be shared by a payout and a reinvestment option.
      details[f.scheme_bse_code] = { isin: f.scheme_isin, transactions: t };
      console.log(`  details ${f.scheme_isin} ${f.scheme_bse_code}  ${f.name}`);
    } catch (err) {
      console.warn(`  details ${f.scheme_isin} skipped: ${err.message}`);
    }
    await pause(500);
  }

  const snapshot = {
    source: base,
    takenAt: new Date().toISOString(),
    floorsRemoved: { minLumpsum: lumpsumFloor || null, minSip: sipFloor || null },
    lists,
    details,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot));
  console.log(`wrote ${lists.length} schemes, ${Object.keys(details).length} fund pages → ${out}`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args.splice(i, 2)[1]) || 0 : 0;
  };
  const lumpsumFloor = flag("--lumpsum-floor");
  const sipFloor = flag("--sip-floor");
  build(args[0] ? path.resolve(args[0]) : DEFAULT_FILE, { lumpsumFloor, sipFloor }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { enabled, snapshotMaster, snapshotScheme, DEFAULT_FILE };
