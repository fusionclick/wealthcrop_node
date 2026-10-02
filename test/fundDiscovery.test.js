// Phase 1, engineer A — fund discovery & catalogue (client demo points #1-#11).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { pickScheme, effectiveLockIn, minSources, subCategoryOf, matchesCategory, categorySearch } = require("../src/mf/scheme");
const { query, facetsOf } = require("../src/mf/catalogue");
const { documentsUrl } = require("../src/mf/kuvera");

describe("#1 a fund resolves from its ISIN alone", () => {
  // BSE keeps a dead duplicate beside the live row: same ISIN, old code, is_active false.
  const dead = { scheme_isin: "INF090I01239", scheme_bse_code: "011-DP", is_active: false };
  const live = { scheme_isin: "INF090I01239", scheme_bse_code: "FR011-DP", is_active: true };

  test("an ISIN alone picks the LIVE row, never BSE's dead duplicate", () => {
    assert.equal(pickScheme([dead, live], "INF090I01239", "").scheme_bse_code, "FR011-DP");
  });

  test("an exact code still wins (old two-segment links)", () => {
    assert.equal(pickScheme([live, dead], "INF090I01239", "011-dp").scheme_bse_code, "011-DP");
  });

  test("a code-only link carries the code in the ISIN slot", () => {
    const other = { scheme_isin: "INF000", scheme_bse_code: "OTHER" };
    assert.equal(pickScheme([other, live], "FR011-DP", "").scheme_bse_code, "FR011-DP");
  });

  // BSE files a plan's IDCW payout and reinvestment options under ONE ISIN — 1,416 ISINs in
  // the live master. The ISIN alone cannot tell them apart; the option in the URL can.
  const reinvest = { scheme_isin: "INF200K01206", scheme_bse_code: "007-DR", scheme_option: "IDCW Reinvestment" };
  const payout = { scheme_isin: "INF200K01206", scheme_bse_code: "SB007-DP", scheme_option: "IDCW Payout" };

  test("an option named in the URL picks between two codes under one ISIN", () => {
    assert.equal(pickScheme([reinvest, payout], "INF200K01206", "", "idcw-payout").scheme_bse_code, "SB007-DP");
    assert.equal(pickScheme([payout, reinvest], "INF200K01206", "", "idcw-reinvestment").scheme_bse_code, "007-DR");
    // The exact code still outranks the option.
    assert.equal(pickScheme([reinvest, payout], "INF200K01206", "007-DR", "idcw-payout").scheme_bse_code, "007-DR");
  });

  test("the catalogue returns the exact code a caller holds, not every row on its ISIN", () => {
    const rows = [
      { name: "R", scheme_isin: "INF200K01206", scheme_bse_code: "007-DR" },
      { name: "P", scheme_isin: "INF200K01206", scheme_bse_code: "SB007-DP" },
    ];
    // The Invest and SIP pages send both; this used to answer with whichever came first.
    assert.deepEqual(query(rows, { isin: "INF200K01206", scheme_code: "SB007-DP" }).lists.map((f) => f.name), ["P"]);
    assert.equal(query(rows, { isin: "INF200K01206" }).total, 2, "an ISIN alone still finds both");
    assert.equal(query(rows, { isin: "INF200K01206", scheme_code: "DEAD-CODE" }).total, 2, "an unknown code falls back to the ISIN");
  });
});

describe("#2 which minimums are the platform's", () => {
  test("a minimum the floor raised or filled is the platform's; an untouched one is BSE's", () => {
    assert.deepEqual(minSources({ minLumpsum: 5000, minSip: null, minAdditional: 1000 }, { minLumpsum: 5000, minSip: 500, minAdditional: 1000 }), {
      lumpsum: "scheme",
      sip: "platform",
      additional: "scheme",
    });
    assert.equal(minSources({ minLumpsum: 100 }, { minLumpsum: 500 }).lumpsum, "platform");
    // Nobody set one: null, which the page prints as N/A — never a number.
    assert.equal(minSources({ minSip: null }, { minSip: null }).sip, null);
  });
});

describe("#3 lock-in: one rule for the page, the cards and Compare", () => {
  test("BSE's own lock-in wins, then the feed's years, then the law for an ELSS", () => {
    const bse = { period: 5, type: "year", label: "5 years" };
    assert.equal(effectiveLockIn({ lockIn: bse, subType: "Equity • ELSS" }), bse);
    assert.equal(effectiveLockIn({ subType: "Solution Oriented • Retirement Fund" }, 5).label, "5 years");
    assert.equal(effectiveLockIn({ subType: "Equity • ELSS" }).label, "3 years", "an ELSS is locked three years by law");
    assert.equal(effectiveLockIn({ category: "Open Ended Schemes(Equity Scheme - ELSS)" }).label, "3 years");
    assert.equal(effectiveLockIn({ subType: "Equity • Flexi Cap" }), null, "no lock-in is invented for anything else");
    // Rows carry the feed's years themselves (kuvera.enrichRows / applyCached).
    assert.equal(effectiveLockIn({ subType: "Hybrid", lockInYears: 5 }).label, "5 years");
  });

  test("the feed's lock-in years ride on the index row", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "mf", "kuvera.js"), "utf8");
    const body = src.slice(src.indexOf("function applyCached"), src.indexOf("\n}", src.indexOf("function applyCached")));
    assert.ok(body.includes("row.lockInYears ="), "applyCached must copy lockInYears for the cards");
  });
});

describe("#5 the only external link a fund page keeps is the compliance documents", () => {
  test("a SID / KIM / SAI page survives; a generic AMC page does not", () => {
    assert.equal(documentsUrl("https://amc.ppfas.com/downloads/kim-sid-and-sai/"), "https://amc.ppfas.com/downloads/kim-sid-and-sai/");
    assert.equal(documentsUrl("https://www.sbimf.com/en-us/offer-document-sid-kim"), "https://www.sbimf.com/en-us/offer-document-sid-kim");
    assert.equal(documentsUrl("https://www.motilaloswalmf.com/download/sid"), "https://www.motilaloswalmf.com/download/sid");
    for (const other of ["https://www.boimf.in/investor-corner", "https://www.360.one/asset-management.html", "https://www.itiamc.com/downloads", "http://example.com/sid", "", null]) {
      assert.equal(documentsUrl(other), null, `${other} must not be offered as the scheme documents`);
    }
  });
});

describe("#11 catalogue ranking & filtering", () => {
  const row = (over) => ({
    name: "FUND",
    category: "Equity",
    subType: "Equity • Large Cap Fund",
    payout: "Growth",
    returns: { "1Y": 10, "3Y": 12, "5Y": 11 },
    fundRating: 3,
    ...over,
  });
  const list = [
    row({ name: "A LARGE", returns: { "3Y": 14 }, fundRating: 5 }),
    row({ name: "B SMALL", subType: "Equity • Small Cap Fund", returns: { "3Y": 22 } }),
    row({ name: "C SMALL GUESSED", subType: "Equity • Small Cap", returns: { "3Y": null } }),
    row({ name: "D LIQUID IDCW", category: "Debt", subType: "Debt • Liquid", payout: "IDCW Payout", returns: { "3Y": 6 }, fundRating: 5 }),
    row({ name: "NIPPON INDIA ETF NIFTY 50 BEES", category: "Other", subType: "Other • Index / ETF", payout: "IDCW Reinvestment" }),
    row({ name: "E NO CATEGORY", category: "Mutual Fund", subType: "Mutual Fund" }),
  ];

  test("the sub-category is read as one option whether BSE wrote 'Fund' after it or not", () => {
    assert.equal(subCategoryOf({ subType: "Equity • Small Cap Fund" }), "Small Cap");
    assert.equal(subCategoryOf({ subType: "Equity • Small Cap" }), "Small Cap");
    assert.equal(subCategoryOf({ subType: "Debt" }), null);
  });

  test("facets offer the catalogue's own categories and the sub-categories under each", () => {
    assert.deepEqual(facetsOf(list), [
      { category: "Debt", subCategories: ["Liquid"] },
      { category: "Equity", subCategories: ["Large Cap", "Small Cap"] },
      { category: "Other", subCategories: ["Index / ETF"] },
    ]);
    assert.equal(facetsOf(list), facetsOf(list), "computed once per index");
  });

  test("category and sub-category both filter, across BSE's and the name-derived spelling", () => {
    assert.deepEqual(query(list, { schemeCategory: "equity", length: 50 }).lists.map((f) => f.name), ["A LARGE", "B SMALL", "C SMALL GUESSED"]);
    assert.deepEqual(query(list, { schemeCategory: "Equity", subCategory: "small cap", length: 50 }).lists.map((f) => f.name), ["B SMALL", "C SMALL GUESSED"]);
    assert.equal(query(list, { schemeCategory: "Debt", subCategory: "Small Cap" }).total, 0);
  });

  test("'High Return' and '5 Star Funds' are real data now, not name searches", () => {
    assert.equal(matchesCategory(row({ returns: { "3Y": null } }), "high_return"), false, "no 3Y return, no place in a returns ranking");
    const high = query(list, { category: "high_return", length: 50 }).lists.map((f) => f.name);
    assert.deepEqual(high.slice(0, 3), ["B SMALL", "A LARGE", "NIPPON INDIA ETF NIFTY 50 BEES"], "ranked by 3Y return by default");
    assert.ok(!high.includes("C SMALL GUESSED"));
    assert.deepEqual(query(list, { category: "5_star_funds", length: 50 }).lists.map((f) => f.name), ["A LARGE", "D LIQUID IDCW"]);
    // An explicit sort still wins over the collection's own order.
    assert.equal(query(list, { category: "high_return", sort: "name", order: "asc" }).lists[0].name, "A LARGE");
    assert.equal(categorySearch("high_return"), "");
    assert.equal(categorySearch("5_star_funds"), "");
  });

  test("Search's Growth / ETF / IDCW / Dividend tags are server-side filters", () => {
    assert.deepEqual(query(list, { txn: "etf", length: 50 }).lists.map((f) => f.name), ["NIPPON INDIA ETF NIFTY 50 BEES"]);
    assert.equal(query(list, { txn: "growth", length: 50 }).total, 4);
    assert.deepEqual(query(list, { txn: "idcw_payout" }).lists.map((f) => f.name), ["D LIQUID IDCW"]);
    assert.deepEqual(query(list, { txn: "idcw_reinvest" }).lists.map((f) => f.name), ["NIPPON INDIA ETF NIFTY 50 BEES"]);
  });
});

describe("dev catalogue snapshot (demo on a machine BSE will not talk to)", () => {
  const file = path.join(os.tmpdir(), `wc-snapshot-${process.pid}.json`);
  const snapshot = {
    source: "test",
    takenAt: "2026-10-02T00:00:00.000Z",
    lists: [
      { name: "HDFC ELSS TAX SAVER", scheme_isin: "INF179K01YS4", scheme_bse_code: "HDFCELSS-GR", category: "Equity", subType: "Equity • ELSS", nav: 1500, holding_modes: { demat: true, physical: true }, minSip: null, minLumpsum: null },
      { name: "DEMAT ONLY FUND", scheme_isin: "INFDEMAT", scheme_bse_code: "DM-GR", category: "Debt", subType: "Debt • Liquid", nav: 10, holding_modes: { demat: true, physical: false } },
      // BSE files both IDCW options of one plan under ONE ISIN.
      { name: "SBI ESG IDCW REINVESTMENT", scheme_isin: "INF200K01206", scheme_bse_code: "007-DR", payout: "IDCW Reinvestment", category: "Equity", subType: "Equity", nav: 70, holding_modes: { demat: true, physical: false } },
      { name: "SBI ESG IDCW PAYOUT", scheme_isin: "INF200K01206", scheme_bse_code: "SB007-DP", payout: "IDCW Payout", category: "Equity", subType: "Equity", nav: 70, holding_modes: { demat: true, physical: false } },
    ],
    // Keyed by BSE code, for the same reason.
    details: { "HDFCELSS-GR": { isin: "INF179K01YS4", transactions: { lumpsum: { allowed: true, minAmount: null, minAdditional: 500 } } } },
  };
  const fresh = () => {
    for (const m of ["devSnapshot", "catalogue"]) delete require.cache[require.resolve(`../src/mf/${m}`)];
    return { snap: require("../src/mf/devSnapshot"), cat: require("../src/mf/catalogue") };
  };
  const env = { file: process.env.MF_DEV_CATALOGUE_SNAPSHOT, node: process.env.NODE_ENV };
  const restore = () => {
    if (env.file === undefined) delete process.env.MF_DEV_CATALOGUE_SNAPSHOT;
    else process.env.MF_DEV_CATALOGUE_SNAPSHOT = env.file;
    if (env.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env.node;
    fresh();
  };

  test("inert unless the variable is set, and inert in production even if it is", () => {
    fs.writeFileSync(file, JSON.stringify(snapshot));
    try {
      delete process.env.MF_DEV_CATALOGUE_SNAPSHOT;
      assert.equal(fresh().snap.snapshotMaster(), null);
      process.env.MF_DEV_CATALOGUE_SNAPSHOT = file;
      process.env.NODE_ENV = "production";
      assert.equal(fresh().snap.snapshotMaster(), null, "a production process must never read it");
      assert.equal(fresh().snap.snapshotScheme("INF179K01YS4"), null);
    } finally {
      restore();
    }
  });

  test("when set, the catalogue and the fund page read it — with no BSE login", async () => {
    fs.writeFileSync(file, JSON.stringify(snapshot));
    const warn = console.warn;
    console.warn = () => {};
    // No network in a unit test: AMFI, the hidden list, the admin categories and the
    // enrichment feed all answer from seeded caches.
    const amfiMod = require("../src/mf/amfiNav");
    const realAmfi = amfiMod.getAmfiNavs;
    amfiMod.getAmfiNavs = async () => ({ at: Date.now(), navs: {}, schemes: [] });
    require("../src/mf/hidden").resetHiddenCache({ codes: [], isins: [] });
    require("../src/mf/categories").resetCategoryCache({});
    require("../src/mf/kuvera").resetEnrichmentCache({ "HDFCELSS-GR": null, "DM-GR": null });
    try {
      process.env.MF_DEV_CATALOGUE_SNAPSHOT = file;
      delete process.env.NODE_ENV;
      const { snap, cat } = fresh();
      const controller = { accessToken: null, loginFunc: async () => assert.fail("must not log in to BSE") };
      const res = await cat.getCatalogue(controller, { mode: "physical", start: 0, length: 20 });
      assert.deepEqual(res.list.map((f) => f.name), ["HDFC ELSS TAX SAVER"], "the silent physical default works on recorded BSE flags");
      assert.deepEqual(res.facets.map((f) => f.category), ["Debt", "Equity"]);

      const one = snap.snapshotScheme("inf179k01ys4");
      assert.equal(one.row.scheme_bse_code, "HDFCELSS-GR");
      assert.equal(one.transactions.lumpsum.minAdditional, 500);
      one.row.minLumpsum = 999; // a caller flooring in place must not change the snapshot
      assert.equal(snap.snapshotScheme("HDFCELSS-GR").row.minLumpsum, null, "a code-only link");
      assert.equal(snap.snapshotScheme("NOPE"), null);
      // One ISIN, two options: the exact code wins, then the option named in the URL.
      assert.equal(snap.snapshotScheme("INF200K01206", "SB007-DP").row.name, "SBI ESG IDCW PAYOUT");
      assert.equal(snap.snapshotScheme("INF200K01206", "", "idcw-payout").row.scheme_bse_code, "SB007-DP");
      assert.equal(snap.snapshotScheme("INF200K01206", "", "idcw-reinvestment").row.scheme_bse_code, "007-DR");
      assert.deepEqual(snap.snapshotScheme("INF200K01206", "007-DR").transactions, {}, "a rulebook is never borrowed from the sibling");
    } finally {
      console.warn = warn;
      amfiMod.getAmfiNavs = realAmfi;
      require("../src/mf/hidden").resetHiddenCache();
      require("../src/mf/categories").resetCategoryCache();
      require("../src/mf/kuvera").resetEnrichmentCache();
      restore();
      fs.rmSync(file, { force: true });
    }
  });
});
