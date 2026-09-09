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
    assert.equal(c.pages(), 1, "master fits one chunk here; raw rows are dropped after mapping");
    // Pehle yahan 5 tha — BSE ka apna count, yaani wo schemes bhi ginta tha jo backend
    // list se nikaal deta hai. Ab `total` filter ke BAAD ki ginti hai, is liye wahi 2
    // jo neeche list mein bhi hain: matured/blocked/unpriced rows count se bhi bahar.
    assert.equal(cat.total, 2, "total counts what the user actually gets");
    assert.equal(cat.total, cat.list.length, "no phantom rows behind the page count");
    assert.equal(cat.fetched, 4, "transactable master size stays visible for debugging");

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

describe("catalogue login failure", () => {
  it("returns empty and logs the reason when BSE login yields no token", async () => {
    const { getCatalogue } = require("../src/mf/catalogue");
    const logged = [];
    const orig = console.error;
    console.error = (...a) => logged.push(a.join(" "));
    try {
      const res = await getCatalogue({
        accessToken: null,
        loginFunc: async () => ({ status: "error", message: "BSE credentials not configured" }),
      });
      assert.deepEqual(res, { list: [], total: 0, unpriced: 0 });
      assert.match(logged.join("\n"), /BSE credentials not configured/);
    } finally {
      console.error = orig;
    }
  });
});

describe("amfi catalogue fallback", () => {
  const SAMPLE = [
    "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date",
    "",
    "Open Ended Schemes(Equity Scheme - Large Cap Fund)",
    "",
    "Axis Mutual Fund",
    "",
    "135762;INF846K01WO1;-;Axis Bluechip Fund;Direct Plan;Growth Option;30.3228;04-Sep-2026",
    "135763;INF846K01WP8;-;Axis Midcap Fund;Direct Plan;Growth Option;0;04-Sep-2026",
  ].join("\n");

  it("reads name, AMC and category out of the section banners", () => {
    const { parseNavSchemes } = require("../src/mf/amfiNav");
    const rows = parseNavSchemes(SAMPLE);
    assert.equal(rows.length, 1, "a zero NAV is not a priced scheme");
    assert.equal(rows[0].scheme_name, "Axis Bluechip Fund");
    assert.equal(rows[0].scheme_amc_name, "Axis Mutual Fund");
    assert.match(rows[0].scheme_category, /Large Cap/);
    assert.equal(rows[0].nav, 30.3228);
  });

  it("stays empty when BSE is down and the flag is off, serves AMFI when it is on", async () => {
    const amfiMod = require("../src/mf/amfiNav");
    const realGet = amfiMod.getAmfiNavs;
    const realFlag = process.env.MF_AMFI_FALLBACK;
    const warn = console.warn;
    console.warn = () => {};
    try {
      amfiMod.getAmfiNavs = async () => ({
        at: Date.now(),
        navs: {},
        schemes: amfiMod.parseNavSchemes(SAMPLE),
      });
      const deadBse = {
        accessToken: null,
        loginFunc: async () => ({ status: "error", message: "unreachable" }),
      };

      delete process.env.MF_AMFI_FALLBACK;
      delete require.cache[require.resolve("../src/mf/catalogue")];
      const off = await require("../src/mf/catalogue").getCatalogue(deadBse, {});
      assert.deepEqual(off, { list: [], total: 0, unpriced: 0 }, "production behaviour is unchanged");

      process.env.MF_AMFI_FALLBACK = "1";
      delete require.cache[require.resolve("../src/mf/catalogue")];
      const on = await require("../src/mf/catalogue").getCatalogue(deadBse, {});
      assert.equal(on.total, 1);
      assert.equal(on.list[0].name, "Axis Bluechip Fund");
      assert.equal(on.list[0].source, "amfi");
    } finally {
      console.warn = warn;
      amfiMod.getAmfiNavs = realGet;
      if (realFlag === undefined) delete process.env.MF_AMFI_FALLBACK;
      else process.env.MF_AMFI_FALLBACK = realFlag;
      delete require.cache[require.resolve("../src/mf/catalogue")];
    }
  });
});

describe("catalogue filters", () => {
// Plan / SIP / holding-mode filters: BSE ke per-scheme flags par, aur `null`
// ("BSE ne bataya nahi") kabhi "no" nahi ginta.
    it("query filters on plan, sip and holding mode", () => {
    const { query } = require("../src/mf/catalogue");
    const rows = [
      { name: "A Direct Growth", plan: "Direct", sip_allowed: true, holding_modes: { demat: true, physical: false } },
      { name: "B Regular Growth", plan: "Regular", sip_allowed: false, holding_modes: { demat: true, physical: true } },
      { name: "C Pension Plan", plan: null, sip_allowed: null, holding_modes: { demat: false, physical: true } },
    ];
    assert.deepEqual(query(rows, { plan: "direct" }).lists.map((r) => r.name), ["A Direct Growth"]);
    assert.deepEqual(query(rows, { sip: "yes" }).lists.map((r) => r.name), ["A Direct Growth"]);
    assert.deepEqual(query(rows, { sip: "no" }).lists.map((r) => r.name), ["B Regular Growth"]);
    assert.deepEqual(query(rows, { mode: "physical" }).lists.map((r) => r.name), ["B Regular Growth", "C Pension Plan"]);
    assert.deepEqual(query(rows, { mode: "demat" }).lists.map((r) => r.name), ["A Direct Growth", "B Regular Growth"]);
    assert.equal(query(rows, {}).total, 3);
    });

    it("scheme flags come off the real BSE shapes", () => {
    const { mapScheme, sipAllowed, planOf } = require("../src/mf/scheme");
    assert.equal(sipAllowed({ systematic: [{ sip_flag: "N" }, { sip_flag: "Y" }] }), true);
    assert.equal(sipAllowed({ systematic: [{ sip_flag: "N" }] }), false);
    assert.equal(sipAllowed({}), null);
    assert.equal(planOf({ scheme_plan: "DIRECT" }), "Direct");
    assert.equal(planOf({ scheme_name: "HDFC Flexi Cap - Regular Plan - Growth" }), "Regular");
    // Pehle null tha, aur null wali scheme Regular aur Direct DONO filters se gayab
    // ho jati thi. Direct plan ka naam mein "Direct" likhna lazmi hai, is liye bina
    // lafz wali scheme Regular hai.
    assert.equal(planOf({ scheme_name: "HDFC Flexi Cap" }), "Regular");

    const physical = mapScheme({
      scheme_name: "Franklin Pension Plan",
      lumpsum: [
        {
          scheme_transaction_type: "Purchase",
          scheme_transaction_mode_allowed: [{ scheme_transaction_mode_demat_physical_allowed: "PHYSICAL" }],
        },
      ],
    });
    assert.equal(physical.physical_only, true);
    assert.equal(mapScheme({ scheme_name: "X" }).physical_only, false);
    });
});

describe("catalogue-wide filtering", () => {
  const amfiMod = require("../src/mf/amfiNav");
  const realGet = amfiMod.getAmfiNavs;

  // 50 schemes, 20 Direct + 20 Regular + 10 bina plan lafz ke. Ek page 20 ka hai, is
  // liye har filter ka sach page se bahar hai — purana code sirf pehla page filter
  // karta tha aur `total` BSE ka poora count deta tha.
  const schemes = Array.from({ length: 50 }, (_, i) => {
    const plan = i < 20 ? " Direct Plan" : i < 40 ? " Regular Plan" : "";
    return {
      scheme_name: `FUND ${String(i).padStart(2, "0")}${plan}`,
      scheme_isin: `INFTEST${String(i).padStart(2, "0")}`,
      scheme_bse_code: `T${i}-GR`,
      systematic: [{ sip_flag: i % 2 === 0 ? "Y" : "N" }],
    };
  });

  async function catalogue() {
    amfiMod.getAmfiNavs = async () => ({
      at: Date.now(),
      navs: Object.fromEntries(schemes.map((s) => [s.scheme_isin, { nav: 10, date: "24-Aug-2026" }])),
    });
    delete require.cache[require.resolve("../src/mf/navStore")];
    delete require.cache[require.resolve("../src/mf/catalogue")];
    let calls = 0;
    const controller = {
      calls: () => calls,
      accessToken: "t",
      loginFunc: async () => {},
      masterDataService: {
        getSchemeMasterList: async (_t, r) => {
          calls++;
          const { start, length } = r.data;
          return { data: { count: schemes.length, lists: schemes.slice(start, start + length) } };
        },
      },
    };
    return { controller, mf: require("../src/mf/catalogue") };
  }

  it("filters the whole catalogue and reports a total the page count can trust", async () => {
    const { controller, mf } = await catalogue();
    try {
      const direct = await mf.getCatalogue(controller, { start: 0, length: 20, plan: "direct" });
      assert.equal(direct.total, 20, "all 20 Direct schemes counted, not just the ones on page 1");
      assert.equal(direct.list.length, 20);
      assert.ok(direct.list.every((f) => f.plan === "Direct"));

      // Regular = 20 labelled + 10 bina lafz wale. Purana planOf null deta tha aur ye
      // 10 dono filters se gayab thin.
      const regular = await mf.getCatalogue(controller, { start: 0, length: 20, plan: "regular" });
      assert.equal(regular.total, 30, "unlabelled schemes count as Regular, not as nothing");
      assert.equal(regular.list.length, 20, "page is still 20 rows");

      // Page 2 of the FILTERED set — pehle yahan BSE ke start=20 ka raw page aata tha.
      const page2 = await mf.getCatalogue(controller, { start: 20, length: 20, plan: "regular" });
      assert.equal(page2.total, 30, "total does not move between pages");
      assert.equal(page2.list.length, 10, "last page carries the remainder, not empties");
      const names = new Set([...regular.list, ...page2.list].map((f) => f.name));
      assert.equal(names.size, 30, "pages do not overlap");

      // Har scheme ka koi na koi plan hai — koi row dono filters se bahar nahi.
      const all = await mf.getCatalogue(controller, { start: 0, length: 100 });
      assert.equal(all.total, direct.total + regular.total, "Direct + Regular = the whole catalogue");

      const sip = await mf.getCatalogue(controller, { start: 0, length: 20, sip: "yes" });
      assert.equal(sip.total, 25, "SIP filter counts across the catalogue too");
      assert.ok(sip.list.every((f) => f.sip_allowed === true));

      // Ek hi master build, phir har request usi index par — 6 requests, 1 BSE call.
      assert.equal(controller.calls(), 1, "master is fetched once and reused");
    } finally {
      amfiMod.getAmfiNavs = realGet;
      delete require.cache[require.resolve("../src/mf/navStore")];
      delete require.cache[require.resolve("../src/mf/catalogue")];
    }
  });
});

describe("hidden schemes", () => {
  const { isHidden, resetHiddenCache, getHidden } = require("../src/mf/hidden");

  it("matches on BSE code or ISIN, case-insensitively", () => {
    resetHiddenCache({ codes: ["FR011-DP"], isins: ["INF179K01VA8"] });
    const hidden = { codes: new Set(["FR011-DP"]), isins: new Set(["INF179K01VA8"]) };
    assert.equal(isHidden(hidden, { scheme_bse_code: "fr011-dp" }), true);
    assert.equal(isHidden(hidden, { scheme_isin: "inf179k01va8" }), true);
    assert.equal(isHidden(hidden, { scheme_bse_code: "119551" }), false);
    assert.equal(isHidden(hidden, {}), false);
  });

  it("fails open when Laravel cannot be reached", async () => {
    // No stub server on the configured host: the list must come back empty rather than
    // throwing, otherwise one Laravel outage empties the whole fund catalogue.
    resetHiddenCache();
    const hidden = await getHidden();
    assert.equal(hidden.codes.size, 0);
    assert.equal(isHidden(hidden, { scheme_bse_code: "ANY" }), false);
  });
});
