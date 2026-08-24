const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseNavAll } = require("../src/mf/amfiNav");

describe("amfi nav feed", () => {
  it("parses both the 6- and 8-column layouts", () => {
    const six = "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date\n" +
      "119551;INF209K01YM2;-;Some Fund;123.4567;24-Aug-2026";
    const eight = "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date\n" +
      "121279;INF194K015G8;INF194K017G4;Bandhan Banking and PSU Fund;Direct Plan;Growth;27.0750;24-Aug-2026";
    assert.deepEqual(parseNavAll(six).INF209K01YM2, { nav: 123.4567, date: "24-Aug-2026" });
    const e = parseNavAll(eight);
    assert.equal(e.INF194K015G8.nav, 27.075, "reads NAV from the second-to-last field");
    assert.equal(e.INF194K017G4.nav, 27.075, "reinvestment ISIN maps to the same NAV");
  });

  it("skips headers, section titles, blanks and unpriced rows", () => {
    const text = [
      "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date",
      "",
      " ",
      "Open Ended Schemes(Debt Scheme - Banking and PSU Fund)",
      "Aditya Birla Sun Life Mutual Fund",
      "1;-;-;No ISIN Fund;10.0;24-Aug-2026",
      "2;INFZERO;-;Zero Nav;0;24-Aug-2026",
      "3;INFJUNK;-;Junk Nav;N.A.;24-Aug-2026",
      "4;INFGOOD;-;Good Fund;55.5;24-Aug-2026",
    ].join("\n");
    assert.deepEqual(parseNavAll(text), { INFGOOD: { nav: 55.5, date: "24-Aug-2026" } });
    assert.deepEqual(parseNavAll(""), {});
  });
});

describe("catalogue", () => {
  const amfiMod = require("../src/mf/amfiNav");
  const realGet = amfiMod.getAmfiNavs;

  const schemes = [
    { scheme_name: "LIVE GROWTH FUND", scheme_isin: "INFLIVE1", scheme_bse_code: "L1-GR" },
    { scheme_name: "BSE ONLY FUND", scheme_isin: "INFBSE1", scheme_bse_code: "B1-GR" },
    { scheme_name: "MATURED FIXED TERM PLAN SERIES 18", scheme_isin: "INFDEAD1", scheme_bse_code: "D1-GR" },
    { scheme_name: "BLOCKED FUND", scheme_isin: "INFLIVE2", scheme_bse_code: "L2-GR", purchase_allowed: "N" },
    { scheme_name: "GOLD SAVINGS FUND", scheme_isin: "INFGOLD1", scheme_bse_code: "G1-GR" },
  ];

  function controller(pageSize) {
    let pages = 0;
    return {
      pages: () => pages,
      accessToken: "t",
      loginFunc: async () => {},
      navService: {
        getNavMasterList: async () => ({
          data: { lists: [{ isin: "INFBSE1", nav: "12.5", nav_date: "23-Oct-2025" }] },
        }),
      },
      masterDataService: {
        getSchemeMasterList: async (_t, r) => {
          pages++;
          const { start, length } = r.data;
          return { data: { count: schemes.length, lists: schemes.slice(start, start + Math.min(length, pageSize)) } };
        },
      },
    };
  }

  it("drops unpriced schemes so every card has a NAV", async () => {
    amfiMod.getAmfiNavs = async () => ({
      at: Date.now(),
      navs: {
        INFLIVE1: { nav: 241.87, date: "24-Aug-2026" },
        INFLIVE2: { nav: 99, date: "24-Aug-2026" },
        INFGOLD1: { nav: 30.5, date: "24-Aug-2026" },
      },
    });
    delete require.cache[require.resolve("../src/mf/navStore")];
    delete require.cache[require.resolve("../src/mf/catalogue")];
    const { getCatalogue, query } = require("../src/mf/catalogue");

    const c = controller(20);
    const cat = await getCatalogue(c, { start: 0, length: 20 });
    assert.equal(c.pages(), 1, "one BSE page — full master OOMs production");
    assert.equal(cat.total, 5, "counts everything BSE returned");

    const names = cat.list.map((f) => f.name);
    assert.ok(names.includes("LIVE GROWTH FUND"), "AMFI-priced scheme kept");
    assert.ok(!names.includes("BSE ONLY FUND"), "no BSE nav dump on the list path");
    assert.ok(!names.includes("MATURED FIXED TERM PLAN SERIES 18"), "unpriced matured scheme dropped");
    assert.ok(!names.includes("BLOCKED FUND"), "purchase_allowed:N dropped even though it is priced");
    assert.deepEqual(cat.list.filter((f) => !(f.nav > 0)), [], "no card without a NAV");
    assert.deepEqual(cat.list.filter((f) => !f.nav_date), [], "every card carries its NAV date");

    // AMFI wins over the stale BSE snapshot
    assert.equal(cat.list.find((f) => f.name === "LIVE GROWTH FUND").nav_date, "24-Aug-2026");

    // totals are exact and pages do not overlap or pad
    assert.equal(query(cat.list, { start: 0, length: 2 }).total, cat.list.length);
    assert.equal(query(cat.list, { start: 0, length: 2 }).lists.length, 2);
    assert.equal(query(cat.list, { start: cat.list.length - 1, length: 20 }).lists.length, 1);

    // search and category filter run over the whole catalogue
    assert.equal(query(cat.list, { search: "gold" }).total, 1);
    assert.equal(query(cat.list, { search: "zzzz" }).total, 0);
    assert.equal(query(cat.list, { category: "gold_funds" }).total, 1);
    assert.equal(query(cat.list, { scheme_code: "L1-GR" }).total, 1, "exact code lookup");

    amfiMod.getAmfiNavs = realGet;
  });
});
