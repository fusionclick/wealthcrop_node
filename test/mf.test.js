const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBseBaseUrl, resolveInvestorUrl } = require("../src/config");
const { isTransactable, mapScheme, parseListQuery, matchesCategory, categorySearch, paginate, listCacheKey, getListCache, setListCache, pickScheme, navLookup, calcReturns, buildChartSeries } = require("../src/mf/scheme");
const { uccMatches, validateOrder, checkSchemeLimits, normalizeOrder, bindUcc } = require("../src/mf/order");

describe("catalogue", () => {
  it("drops inactive and purchase-blocked schemes", () => {
    assert.equal(isTransactable({ scheme_status: "active", purchase_allowed: "Y" }), true);
    assert.equal(isTransactable({ scheme_status: "inactive" }), false);
    assert.equal(isTransactable({ purchase_allowed: "N" }), false);
    assert.equal(isTransactable({}), true);
  });

  it("maps BSE fields without invented AUM/ratings", () => {
    const mapped = mapScheme({
      scheme_name: "SBI Growth",
      scheme_isin: "INF123",
      scheme_bse_code: "007G",
      scheme_category: "Equity",
      min_lumpsum_amount: 5000,
    });
    assert.equal(mapped.name, "SBI Growth");
    assert.equal(mapped.scheme_bse_code, "007G");
    assert.equal(mapped.minLumpsum, 5000);
    assert.equal(mapped.fundSize, undefined);
    assert.equal(mapped.rating, undefined);
    assert.equal(mapped.returns["3Y"], null);
    assert.equal(pickScheme([{ scheme_isin: "inf1", scheme_bse_code: "X" }, { scheme_isin: "INF109K01U92", scheme_bse_code: "8130-GR" }], "inf109k01u92", "8130-gr").scheme_bse_code, "8130-GR");
    assert.equal(navLookup({ INF109K01U92: { nav: "10.5" } }, "inf109k01u92", "8130-GR"), 10.5);
    assert.equal(calcReturns(120, { "1Y": 100 })["1Y"], 20);
    const series = buildChartSeries(100, { "3Y": 12 });
    assert.ok(series.length > 2 && series.length < 500);
    assert.ok(series[0].nav < series[series.length - 1].nav);
    assert.equal(series[series.length - 1].nav, 100);
    assert.deepEqual(buildChartSeries(null), []);
    const { chartFromSeries } = require("../src/mf/scheme");
    assert.equal(chartFromSeries(series).length, series.length);
    assert.equal(mapScheme({ scheme_name: "ICICI ELSS Tax Saver", scheme_category: "Not Specified" }).subType, "Equity • ELSS");
    assert.equal(mapScheme({ scheme_name: "X", scheme_riskometer: "Not Specified" }).risk, null);
    const { parseNavRows, calcReturnsFromSeries, fundProfile } = require("../src/mf/scheme");
    const rows = parseNavRows([
      { date: "01-01-2024", nav: "100" },
      { date: "01-01-2025", nav: "120" },
    ]);
    assert.equal(calcReturnsFromSeries(rows)["1Y"] > 0, true);
    assert.equal(fundProfile("ICICI Gold ETF FOF", "FoF").assetSplit[0].label, "Commodities");
  });

  it("paginates and parses list query", () => {
    const q = parseListQuery({ start: 20, length: 10, search: "gold" });
    assert.deepEqual(q, { start: 20, length: 10, search: "gold", category: "", isin: "", scheme_code: "" });
    assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), [3, 4]);
    assert.equal(matchesCategory({ name: "HDFC Large Cap", subType: "Equity • Large Cap" }, "large_cap"), true);
    assert.equal(matchesCategory({ name: "Nippon Gold", subType: "Commodity" }, "gold_funds"), true);
    assert.equal(matchesCategory({ name: "SBI ESG Exclusionary", subType: "Equity" }, "gold_funds"), false);
    assert.equal(categorySearch("gold_funds"), "GOLD");
    assert.equal(categorySearch("large_cap"), "LARGE CAP");
    const key = listCacheKey({ category: "mid_cap", search: "MID CAP", start: 0, length: 20 });
    setListCache(key, { ok: 1 });
    assert.equal(getListCache(key).ok, 1);
    const { mapNavRows, navFor, navDateFor } = require("../src/mf/navStore");
    const navs = mapNavRows([{ isin: "inf1", bse_scheme_code: "007G", nav: "12.5", nav_date: "23-Oct-2025" }]);
    assert.equal(navFor(navs, "INF1"), 12.5);
    assert.equal(navFor(navs, null, "007g"), 12.5);
    assert.equal(navDateFor(navs, "INF1"), "23-Oct-2025");
    assert.equal(navFor(navs, "MISSING"), null);
  });

  it("falls back from unresolved prod host to demo", () => {
    assert.equal(resolveBseBaseUrl("https://starmfv2.bseindia.com"), "https://starmfv2demo.bseindia.com");
    assert.equal(resolveBseBaseUrl("https://starmfv2demo.bseindia.com"), "https://starmfv2demo.bseindia.com");
  });

  it("does not auth investors against localhost derived from a local webhook", () => {
    assert.equal(
      resolveInvestorUrl("", "http://127.0.0.1:8000/api/internal/bse/payment-callback"),
      "https://admin.wealthcrop.co/api/internal/investor-data"
    );
    assert.equal(
      resolveInvestorUrl("http://127.0.0.1:8000/api/internal/investor-data", ""),
      "http://127.0.0.1:8000/api/internal/investor-data"
    );
    assert.equal(
      resolveInvestorUrl("", "https://admin.wealthcrop.co/api/internal/bse/payment-callback"),
      "https://admin.wealthcrop.co/api/internal/investor-data"
    );
    // prod mein explicit localhost bhi ignore — deployed .env yahi galti karti hai
    process.env.NODE_ENV = "production";
    assert.equal(
      resolveInvestorUrl("http://127.0.0.1:8000/api/internal/investor-data", ""),
      "https://admin.wealthcrop.co/api/internal/investor-data"
    );
    delete process.env.NODE_ENV;
  });
});

describe("nav store", () => {
  const { mapNavRows, navFor, navDateFor, refresh, getNavs } = require("../src/mf/navStore");

  it("keeps the newest NAV per scheme and drops junk", () => {
    const dup = [
      { isin: "INFDUP", nav: "10", nav_date: "01-Jun-2025" },
      { isin: "INFDUP", nav: "12", nav_date: "28-Dec-2025" },
      { isin: "INFDUP", nav: "11", nav_date: "23-Oct-2025" },
    ];
    assert.equal(navFor(mapNavRows(dup), "INFDUP"), 12);
    assert.equal(navFor(mapNavRows([...dup].reverse()), "INFDUP"), 12, "order-independent");
    assert.equal(navDateFor(mapNavRows(dup), "INFDUP"), "28-Dec-2025");
    assert.deepEqual(mapNavRows([{ isin: "A", nav: "0" }, { isin: "B", nav: "x" }, { isin: "C" }, { nav: "5" }]), {});
  });

  it("pulls the whole list — the demo has no NAV near today", async () => {
    // Stub AMFI: this test pins BSE behaviour and must not touch the network.
    // navStore destructures getAmfiNavs at require time, so reload it after stubbing.
    const amfiMod = require("../src/mf/amfiNav");
    const realGet = amfiMod.getAmfiNavs;
    amfiMod.getAmfiNavs = async () => ({ at: Date.now(), navs: {} });
    delete require.cache[require.resolve("../src/mf/navStore")];
    const { refresh, getNavs, navFor } = require("../src/mf/navStore");
    // Regression: filtering by nav_date (or walking back from today) finds nothing,
    // because the demo dataset is frozen months in the past.
    let sent = null;
    const rows = [
      { isin: "INF200K01214", bse_scheme_code: "007G", nav: "245.92", nav_date: "23-Oct-2025" },
      { isin: "INFOLD", nav: "50", nav_date: "01-Jun-2025" },
      { isin: "INFNEW", nav: "60", nav_date: "28-Dec-2025" },
    ];
    let calls = 0;
    const fake = {
      accessToken: "t",
      loginFunc: async () => {},
      navService: { getNavMasterList: async (_t, r) => ((sent = r), calls++, { data: { lists: rows } }) },
    };
    const snap = await refresh(fake);
    assert.deepEqual(sent.data.filter_param, {}, "no nav_date filter");
    assert.equal(calls, 1, "one call, no per-day walk-back");
    assert.equal(snap.loaded, true);
    assert.equal(snap.date, "28-Dec-2025", "newest date wins even seeded from null");
    assert.equal(navFor(snap.navs, "inf200k01214"), 245.92, "case-insensitive isin");
    assert.equal(navFor(snap.navs, null, "007g"), 245.92, "case-insensitive bse code");
    assert.equal(navFor(snap.navs, "UNLISTED"), null, "absent scheme reports null, not a guess");
    await getNavs(fake);
    assert.equal(calls, 1, "cached inside the TTL");
    amfiMod.getAmfiNavs = realGet;
  });

  it("prefers AMFI over the stale BSE snapshot", async () => {
    const amfiMod = require("../src/mf/amfiNav");
    const realGet = amfiMod.getAmfiNavs;
    amfiMod.getAmfiNavs = async () => ({
      at: Date.now(),
      navs: { INFSHARED: { nav: 241.87, date: "24-Aug-2026" } },
    });
    delete require.cache[require.resolve("../src/mf/navStore")];
    const store = require("../src/mf/navStore");
    const fake = {
      accessToken: "t",
      loginFunc: async () => {},
      navService: {
        getNavMasterList: async () => ({
          data: { lists: [
            { isin: "INFSHARED", nav: "245.92", nav_date: "23-Oct-2025" },
            { isin: "INFBSEONLY", nav: "10.5", nav_date: "23-Oct-2025" },
          ] },
        }),
      },
    };
    const snap = await store.refresh(fake);
    assert.equal(store.navFor(snap.navs, "INFSHARED"), 241.87, "AMFI wins on overlap");
    assert.equal(store.navDateFor(snap.navs, "INFSHARED"), "24-Aug-2026");
    assert.equal(store.navFor(snap.navs, "INFBSEONLY"), null, "BSE dump skipped when AMFI is present");

    // BSE down must not wipe AMFI coverage
    delete require.cache[require.resolve("../src/mf/navStore")];
    const store2 = require("../src/mf/navStore");
    const broken = {
      accessToken: "t",
      loginFunc: async () => {},
      navService: { getNavMasterList: async () => { throw new Error("BSE unreachable"); } },
    };
    const snap2 = await store2.refresh(broken);
    assert.equal(store2.navFor(snap2.navs, "INFSHARED"), 241.87, "AMFI survives a BSE outage");
    amfiMod.getAmfiNavs = realGet;
  });
});

describe("orders", () => {
  const investor = { kyc: { ucc_code: "USRWC003" } };

  it("binds UCC and rejects mismatch", () => {
    assert.equal(uccMatches(investor, {}).ok, true);
    assert.equal(uccMatches(investor, { data: { orders: [{ investor: { ucc: "OTHER" } }] } }).ok, false);
    assert.equal(uccMatches({ kyc: {} }, {}).ok, false);
  });

  it("validates purchase", () => {
    assert.equal(validateOrder({}).ok, false);
    assert.equal(validateOrder({ data: { orders: [{ type: "p", scheme: "007G", amount: 0 }] } }).ok, false);
    const ok = validateOrder({ data: { orders: [{ type: "p", scheme: "007G", amount: 5000 }] } });
    assert.equal(ok.ok, true);
    const minFail = checkSchemeLimits(ok.order, { min_lumpsum_amount: 10000, purchase_allowed: "Y" });
    assert.equal(minFail.ok, false);
    const minOk = checkSchemeLimits(ok.order, { min_lumpsum_amount: 1000, purchase_allowed: "Y" });
    assert.equal(minOk.ok, true);
    const blocked = checkSchemeLimits(ok.order, { purchase_allowed: "N" });
    assert.equal(blocked.ok, false);
  });

  it("validates redemption", () => {
    assert.equal(validateOrder({ data: { orders: [{ type: "r", scheme: "007G", amount: 100 }] } }).ok, false);
    const ok = validateOrder({ data: { orders: [{ type: "r", scheme: "007G", amount: 100, folio: "123" }] } });
    assert.equal(ok.ok, true);
    const all = validateOrder({ data: { orders: [{ type: "r", scheme: "007G", all_units: true, folio: "123" }] } });
    assert.equal(all.ok, true);
  });

  it("normalizes member and UCC", () => {
    const n = normalizeOrder({ type: "p", scheme: "007G", amount: 5000 }, { ucc: "USRWC003", memberCode: "91010" });
    assert.equal(n.investor.ucc, "USRWC003");
    assert.equal(n.member, "91010");
    const bound = bindUcc({ data: { investor: { ucc: "X" }, order_ids: [1] } }, "USRWC003", "91010");
    assert.equal(bound.data.investor.ucc, "USRWC003");
  });
});

describe("bse error message", () => {
  it("prefers BSE's own reason over the axios message", () => {
    const { bseMessage } = require("../src/controllers/StarMFController");
    assert.equal(bseMessage({ response: { data: { message: "UCC not registered" } }, message: "Request failed with status code 500" }), "UCC not registered");
    assert.equal(bseMessage({ response: { data: { errors: [{ message: "scheme not allowed" }] } } }), "scheme not allowed");
    assert.equal(bseMessage({ message: "socket hang up" }), "socket hang up");
    assert.equal(bseMessage({}), "BSE request failed");
  });
});

describe("bse failure detection", () => {
  const { bseFailure } = require("../src/controllers/StarMFController");
  it("leaves working responses alone", () => {
    assert.equal(bseFailure({ status: "success", data: { items: [{ id: 1, status: "ACCEPTED" }] } }), null);
    assert.equal(bseFailure({ data: { lists: [] } }), null, "absent status is not a failure");
    assert.equal(bseFailure(undefined), null);
  });
  it("catches explicit rejections and names the reason", () => {
    assert.equal(bseFailure({ status: "failure", message: "UCC not registered" }), "UCC not registered");
    assert.equal(
      bseFailure({ status: "success", data: { items: [{ status: "error", message: "scheme not allowed for this member" }] } }),
      "scheme not allowed for this member",
      "per-order rejection inside a 200 body"
    );
    assert.equal(bseFailure({ status: "error" }), "BSE rejected the request");
  });
});

describe("mobile normalization", () => {
  const { normalizeMobile, investorMobile, normalizeOrder } = require("../src/mf/order");
  it("strips +91, spaces and leading zeros", () => {
    assert.equal(normalizeMobile("+91 861 702 9131"), "8617029131");
    assert.equal(normalizeMobile("08617029131"), "8617029131");
    assert.equal(normalizeMobile("918617029131"), "8617029131");
  });
  it("rejects numbers BSE will not accept", () => {
    assert.equal(normalizeMobile("1987542630"), "", "Indian mobiles start 6-9");
    assert.equal(normalizeMobile("12345"), "");
    assert.equal(normalizeMobile(""), "");
  });
  it("falls back to the test account number only for that email", () => {
    assert.equal(investorMobile({ email: "rminhal783@gmail.com", phone: "1987542630" }), "8617029131");
    assert.equal(investorMobile({ email: "someone@else.com", phone: "1987542630" }), "");
    assert.equal(investorMobile({ email: "someone@else.com", phone: "9876543210" }), "9876543210");
  });
  it("puts the clean number on the order and every holder", () => {
    const o = normalizeOrder(
      { type: "p", amount: 5000, mobnum: "1987542630", holder: [{ holder_rank: "1", mobnum: "1987542630" }] },
      { ucc: "USRWC003", memberCode: "91010", mobile: "8617029131" }
    );
    assert.equal(o.mobnum, "8617029131");
    assert.equal(o.holder[0].mobnum, "8617029131");
  });
});

describe("bse messages[] errors", () => {
  const { bseFailure } = require("../src/controllers/StarMFController");
  const { normalizeOrder } = require("../src/mf/order");
  it("names the field BSE complained about", () => {
    assert.equal(
      bseFailure({ status: "error", data: {}, messages: [{ msgid: 1522, errcode: "required", field: "726215.depository_acct", vals: [""] }] }),
      "depository_acct is required",
      "strips the order-ref prefix off the field"
    );
    assert.equal(
      bseFailure({ status: "error", data: null, messages: [{ msgid: 522, errcode: "required", field: "OpenClose" }] }),
      "OpenClose is required"
    );
  });
  it("sends physical unless real DP details are present", () => {
    const base = { type: "p", amount: 5000, phys_or_demat: "d" };
    const opts = { ucc: "USRWC003", memberCode: "91010", mobile: "8617029131" };
    assert.equal(normalizeOrder(base, opts).phys_or_demat, "P", "no DP details -> physical");
    assert.equal(normalizeOrder({ ...base, depository_acct: { dp_id: "", client_id: "" } }, opts).phys_or_demat, "P");
    assert.equal(
      normalizeOrder({ ...base, depository_acct: { depository: "C", dp_id: "12345678", client_id: "87654321" } }, opts).phys_or_demat,
      "D"
    );
  });
});

describe("error message is always a string", () => {
  const { bseMessage } = require("../src/controllers/StarMFController");
  it("never hands the UI an object to render", () => {
    // React error #31: the payment handler used to put error.response.data
    // straight into `message`, and the UI rendered it as a child.
    const err = { response: { data: { status: "error", data: {}, messages: [{ errcode: "required", field: "amount" }] } } };
    assert.equal(typeof bseMessage(err), "string");
    assert.equal(bseMessage(err), "amount is required", "reads BSE's messages[] instead of axios' status text");
    assert.equal(typeof bseMessage({ response: { data: "plain text body" } }), "string");
    // BSE puts the actual reason in vals; dropping it left "get_2fa_link was not found".
    const withVals = {
      response: {
        data: {
          messages: [
            { errcode: "record_not_found", field: "get_2fa_link", vals: ["No valid responses generated for the provided requests"] },
          ],
        },
      },
    };
    assert.match(bseMessage(withVals), /No valid responses generated/);
    const codeOnly = { response: { data: { messages: [{ errcode: "not_allowed", field: "x.PhysOrDemat", vals: ["d"] }] } } };
    assert.equal(bseMessage(codeOnly), "PhysOrDemat is not allowed", "a bare flag is not an explanation");
    assert.equal(typeof bseMessage({}), "string");
  });
});

describe("scheme transactability", () => {
  it("drops schemes BSE marks inactive or closed", () => {
    // Real BSE master field names — the old code read purchase_allowed/scheme_status,
    // which BSE never sends, so every scheme passed and closed ones failed at order time.
    assert.equal(isTransactable({ is_active: "N" }), false);
    assert.equal(isTransactable({ amc_active_flag: "N" }), false);
    assert.equal(isTransactable({ scheme_offer_status: "Close" }), false);
    assert.equal(isTransactable({ lumpsum: { allowed: "N" } }), false);
  });

  it("keeps a scheme when BSE says nothing", () => {
    // Only an explicit no excludes — a guessed-wrong field name must never empty the list.
    assert.equal(isTransactable({}), true);
    assert.equal(isTransactable({ is_active: "Y", scheme_offer_status: "Open" }), true);
    assert.equal(isTransactable({ lumpsum: { min_amount: 5000 } }), true);
  });
});

describe("ucc readiness", () => {
  const { uccBlocks } = require("../src/mf/order");
  // Shape taken from a live get_ucc for USRWC003 on 2026-08-25.
  const info = {
    is_client_physical: false,
    is_client_demat: true,
    ucc_status: "PENDING_VERIFICATION",
    transaction_ready: [
      { mode: "DEMAT", verified_status: "FALSE", verification_failed_reason: "Ucc Verification for demat is pending" },
    ],
  };

  it("blocks a physical order on a demat-only account", () => {
    assert.match(uccBlocks(info, "P"), /registered for demat only/);
  });

  it("does not block a demat order while verification is pending", () => {
    // BSE accepted 9 real orders on USRWC003 in exactly this state, so verified_status
    // is not a precondition for placing one. Blocking on it stopped valid orders.
    assert.equal(uccBlocks(info, "D"), null);
  });

  it("stays out of the way when the UCC could not be read", () => {
    // A failed lookup must not become a wall in front of every order.
    assert.equal(uccBlocks(null, "D"), null);
    assert.equal(uccBlocks({}, "D"), null);
  });
});

describe("2FA UCC link payload", () => {
  const { twoFaUccPayload } = require("../src/mf/order");
  const info = {
    holding_nature: "SI",
    holder: [
      {
        identifier: [
          { identifier_type: "pan", identifier_number: "AVDPV9611N" },
          { identifier_type: "accredited_investor", identifier_number: "9884520120" },
        ],
      },
    ],
  };

  it("asks for the real client, not the sample one", () => {
    // The handler used to post fetch2FALinkRequestData verbatim: client_code ABCD1234,
    // member_code 0000. No real investor could ever get an eLog link.
    const p = twoFaUccPayload("UCC_ELOG", { ucc: "USRWC003", info, memberCode: "91010" }).data[0];
    assert.equal(p.event, "UCC_ELOG");
    assert.equal(p.investor.client_code, "USRWC003");
    assert.equal(p.member_code, "91010");
    assert.deepEqual(p.investor.pan_holder, ["AVDPV9611N"], "PAN only, not every identifier");
    assert.equal(p.investor.holding_nature, "SI");
  });

  it("still forms a payload when the UCC could not be read", () => {
    const p = twoFaUccPayload("UCC_NOM", { ucc: "USRWC003", info: null, memberCode: "91010" }).data[0];
    assert.deepEqual(p.investor.pan_holder, [""]);
    assert.equal(p.investor.holding_nature, "");
  });
});

describe("physical vs demat", () => {
  const { allowedModes } = require("../src/mf/order");
  const scheme = (mode) => ({
    lumpsum: [
      {
        scheme_transaction_type: "Purchase",
        scheme_transaction_mode_allowed: [{ scheme_transaction_mode_demat_physical_allowed: mode }],
      },
      {
        scheme_transaction_type: "Redemption",
        scheme_transaction_mode_allowed: [{ scheme_transaction_mode_demat_physical_allowed: "Demat" }],
      },
    ],
  });
  const base = {
    type: "p",
    scheme: "FR011-DP",
    amount: 5000,
    depository_acct: { depository: "C", dp_id: "12345678", client_id: "87654321" },
  };
  const opts = { ucc: "USRWC003", memberCode: "91010", mobile: "8617029131" };

  it("goes physical when the scheme refuses demat", () => {
    // BSE msgid 1588: Franklin Pension Plan is Physical-only, and we sent "d".
    const n = normalizeOrder(base, { ...opts, modes: allowedModes(scheme("Physical")) });
    assert.equal(n.phys_or_demat, "P");
    assert.deepEqual(n.depository_acct, {}, "no DP block on a physical order");
  });

  it("stays demat when the scheme allows it", () => {
    const n = normalizeOrder(base, { ...opts, modes: allowedModes(scheme("Demat")) });
    assert.equal(n.phys_or_demat, "D");
    assert.equal(n.depository_acct.dp_id, "12345678");
  });

  it("reads the mode for the transaction type being placed", () => {
    assert.deepEqual(allowedModes(scheme("Physical"), "Redemption"), { demat: true, physical: false });
  });

  it("keeps the old behaviour when BSE says nothing", () => {
    assert.equal(allowedModes({}), null);
    assert.equal(normalizeOrder(base, { ...opts, modes: null }).phys_or_demat, "D");
  });
});

describe("purchase window", () => {
  const { windowOpen } = require("../src/mf/scheme");
  const scheme = (start, end) => ({
    lumpsum: [
      {
        scheme_transaction_type: "Purchase",
        scheme_transaction_effective_start_date: start,
        scheme_transaction_effective_end_date: end,
      },
    ],
  });
  const now = Date.parse("2026-08-26T00:00:00");

  it("drops a scheme whose window has closed", () => {
    // FR011-DP closed on 2025-06-20 and still sat in the catalogue.
    assert.equal(windowOpen(scheme("2016-04-06T00:00:00", "2025-06-20T14:58:13.467"), "Purchase", now), false);
  });

  it("keeps a scheme whose window is open", () => {
    assert.equal(windowOpen(scheme("2010-07-19T00:00:00", "2037-12-31T00:00:00"), "Purchase", now), true);
  });

  it("drops a scheme that has not opened yet", () => {
    assert.equal(windowOpen(scheme("2030-01-01T00:00:00", "2037-12-31T00:00:00"), "Purchase", now), false);
  });

  it("keeps a scheme when BSE gives no window", () => {
    assert.equal(windowOpen({}, "Purchase", now), true);
    assert.equal(windowOpen(scheme("", ""), "Purchase", now), true);
  });
});

describe("catalogue hides what cannot be bought", () => {
  const { allowedModes } = require("../src/mf/scheme");
  const buyable = (row) => allowedModes(row)?.demat !== false;
  const row = (mode) => ({
    lumpsum: [
      {
        scheme_transaction_type: "Purchase",
        scheme_transaction_mode_allowed: [{ scheme_transaction_mode_demat_physical_allowed: mode }],
      },
    ],
  });

  it("drops physical-only schemes", () => {
    assert.equal(buyable(row("Physical")), false);
    assert.equal(buyable(row("Demat")), true);
  });

  it("keeps a scheme when BSE states no mode", () => {
    // Silence must not empty the catalogue.
    assert.equal(buyable({}), true);
  });
});

describe("scheme code resolution", () => {
  // BSE keeps a dead row on the old code (011-DP) beside the live one (FR011-DP).
  // Links minted before the filter landed still carry the dead code.
  const lists = [
    { scheme_bse_code: "011-DP", scheme_isin: "INF090I01536", is_active: false },
    { scheme_bse_code: "FR011-DP", scheme_isin: "INF090I01536", is_active: true },
    { scheme_bse_code: "FR011-DR", scheme_isin: "INF090I01536", is_active: true },
  ];
  const codeOf = (r) => String(r?.scheme_bse_code || "").trim().toUpperCase();
  const isinOf = (r) => String(r?.scheme_isin || "").trim().toUpperCase();
  const resolve = (needle) => {
    const matches = lists.filter((r) => codeOf(r) === needle || isinOf(r) === needle);
    const live = matches.find(isTransactable);
    if (live) return live;
    const dead = matches[0];
    if (!dead) return null;
    return (
      lists.find((r) => isTransactable(r) && isinOf(r) === isinOf(dead) && codeOf(r).endsWith(needle)) || dead
    );
  };

  it("follows a retired code to the live scheme", () => {
    assert.equal(resolve("011-DP").scheme_bse_code, "FR011-DP");
  });

  it("never crosses the payout/reinvestment line", () => {
    // Same ISIN on both rows here, so ISIN alone would be enough to pick DR. It must not.
    assert.notEqual(resolve("011-DP").scheme_bse_code, "FR011-DR");
  });

  it("returns nothing when the code is unknown", () => {
    assert.equal(resolve("NOPE-GR"), null);
  });
});

describe("payment page proxy", () => {
  const base = "https://starmfv2demo.bseindia.com";
  const prefix = "/api/bse/pg";
  // proxify: host badlo, path chhoro — proxyPaymentPage suffix ko wapas baseUrl par lagata hai.
  const proxify = (s) => String(s).split(base).join(prefix);
  const upstream = (url) => `${base}/${url.slice(prefix.length + 1)}`;

  it("points BSE's own links back through the proxy", () => {
    const body = JSON.stringify({ data: { exch_pg_page_link: `${base}/api/s4/pg_view_object/TOK123` } });
    const out = JSON.parse(proxify(body));
    assert.equal(out.data.exch_pg_page_link, "/api/bse/pg/api/s4/pg_view_object/TOK123");
    assert.equal(upstream(out.data.exch_pg_page_link), `${base}/api/s4/pg_view_object/TOK123`, "round-trips");
  });

  it("rewrites hosts that the page concatenates at runtime", () => {
    // This was the bug: the page holds the bare origin in a variable and builds
    // `origin + "/api/get_ucc_details"` in JS, so `${base}/api/` never appears literally.
    const js = `var API = "${base}"; fetch(API + "/api/get_ucc_details")`;
    assert.ok(!proxify(js).includes("bseindia.com"), "no absolute BSE URL survives");
    assert.equal(upstream(`${prefix}/api/get_ucc_details`), `${base}/api/get_ucc_details`);
  });

  it("keeps non-/api paths intact", () => {
    assert.equal(upstream(proxify(`${base}/static/pg.css`)), `${base}/static/pg.css`);
  });

  it("retries once with /api when an old-style link 404s", async () => {
    // Old links were built while the proxy swallowed /api. Both shapes must land.
    const asked = [];
    const fetchUpstream = async (path) => {
      asked.push(path);
      return { status: path.startsWith("api/") ? 200 : 404 };
    };
    const resolve = async (suffix) => {
      let r = await fetchUpstream(suffix);
      if (r.status === 404 && !suffix.startsWith("api/")) r = await fetchUpstream(`api/${suffix}`);
      return r.status;
    };
    assert.equal(await resolve("s4/pg_view_object/TOK"), 200);
    assert.deepEqual(asked, ["s4/pg_view_object/TOK", "api/s4/pg_view_object/TOK"]);
    asked.length = 0;
    assert.equal(await resolve("api/s4/pg_view_object/TOK"), 200);
    assert.equal(asked.length, 1, "new-style link costs one request, no retry");
  });

  it("leaves other hosts alone", () => {
    const html = '<a href="https://bank.example/pay">pay</a>';
    assert.equal(proxify(html), html);
  });
});
