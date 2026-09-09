const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildXspListPayload, scopeXspResponse } = require("../src/controllers/StarMFController");

// Wahi key set jo src/mf/catalogue.js production mein bhejta hai aur BSE accept karta hai.
const PROVEN_KEYS = ["start", "length", "fields", "count_only", "filter_param", "search"];
const BANNED = ["format", "sort_by", "sort_dir", "is_compressed"];

describe("getAllXsp payload", () => {
  it("sirf proven key set bhejta hai", () => {
    const built = buildXspListPayload({ start: 0, length: 50 }, "U1").data;
    assert.deepEqual(Object.keys(built).sort(), [...PROVEN_KEYS].sort());
  });

  it("wo keys nahi jinhone BSE se invalid_json khaya", () => {
    const built = buildXspListPayload({ start: 0, length: 50 }, "U1").data;
    BANNED.forEach((k) => assert.equal(built[k], undefined, `${k} wapas aa gaya`));
    assert.equal(built.filter_param.freq, undefined, "freq wapas aa gaya");
  });

  it("filter_param bilkul khali — /sxp_list koi bhi key ho to invalid_json deta hai", () => {
    // Live BSE par har variant chala kar verify kiya: sxp_type, status, ucc, member_code —
    // har ek akela bhi `invalid_json` laata hai, aur executeWithRetry usay 502 bana deta
    // hai. Wohi 502 har SIPs page load par aa raha tha. Sirf khali filter_param chalta hai.
    assert.deepEqual(buildXspListPayload({}, "U1").data.filter_param, {});
  });

  it("search object hai, string nahi", () => {
    // `search: "U1"` bhi invalid_json deta hai; sirf {value} shape accept hoti hai.
    const { search } = buildXspListPayload({}, "U1").data;
    assert.equal(typeof search, "object");
    assert.deepEqual(search, { value: "U1" });
  });

  it("koi khali string value nahi — BSE unhe enum nahi manta", () => {
    const { data } = buildXspListPayload({ start: 0, length: 50 }, "U1");
    const empties = [];
    const walk = (o, path = "") =>
      Object.entries(o).forEach(([k, v]) => {
        if (v === "") empties.push(path + k);
        else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, `${path}${k}.`);
      });
    walk(data);
    assert.deepEqual(empties, []);
  });

  it("start/length caller se aate hain, length 100 par capped", () => {
    assert.equal(buildXspListPayload({ start: 20, length: 10 }, "U1").data.start, 20);
    assert.equal(buildXspListPayload({ start: 20, length: 10 }, "U1").data.length, 10);
    assert.equal(buildXspListPayload({ length: 5000 }, "U1").data.length, 100);
  });

  it("UCC authenticated session se aata hai, browser body se nahi", () => {
    const { data } = buildXspListPayload({ search: { value: "ATTACKER1" } }, "U1");
    assert.deepEqual(data.search, { value: "U1" });
  });

  it("kachra input par bhi valid payload", () => {
    for (const bad of [undefined, null, {}, { start: "x", length: "y" }, { length: -5 }, { start: -9 }]) {
      const { data } = buildXspListPayload(bad, "U1");
      assert.equal(data.start, 0);
      assert.ok(data.length > 0 && data.length <= 100, `length=${data.length}`);
    }
  });
});

describe("scopeXspResponse", () => {
  const rows = (lists) => ({ status: "success", data: { lists } });

  it("sirf apne UCC ki SIP rakhta hai", () => {
    const r = scopeXspResponse(rows([{ ucc: "A1", id: 1 }, { ucc: "B2", id: 2 }, { client_code: "A1", id: 3 }]), "A1");
    assert.deepEqual(r.data.lists.map((x) => x.id), [1, 3]);
    assert.equal(r.data.count, 2);
  });

  it("doosre client ka data kabhi leak nahi hota", () => {
    const r = scopeXspResponse(rows([{ ucc: "B2" }, { ucc: "C3" }]), "A1");
    assert.deepEqual(r.data.lists, []);
    assert.equal(r.data.count, 0);
  });

  it("SIP ki chhanti ab yahan hoti hai, kyunki BSE se maangi nahi ja sakti", () => {
    const r = scopeXspResponse(
      rows([
        { ucc: "A1", id: 1, sxp_type: "SIP", status: "ACTIVE" },
        { ucc: "A1", id: 2, sxp_type: "STP", status: "ACTIVE" },
        { ucc: "A1", id: 3, sxp_type: "SIP", status: "CANCELLED" },
        { ucc: "A1", id: 4, sxp_type: "SIP", status: "Expired" },
      ]),
      "A1"
    );
    assert.deepEqual(r.data.lists.map((x) => x.id), [1]);
    assert.equal(r.data.total_count, 1, "BSE ka pre-filter total wapas nahi jana chahiye");
  });

  it("anjaan shape par fail-open — kisi ki asli SIP chhupti nahi", () => {
    // Demo book khali hai, is liye asli field naam confirm nahi hue. Row sirf tab girti
    // hai jab koi pehchani hui field maujood ho aur saaf mukhalif ho.
    const r = scopeXspResponse(rows([{ ucc: "A1", id: 1 }, { ucc: "A1", id: 2, status: "ACTIVE" }]), "A1");
    assert.deepEqual(r.data.lists.map((x) => x.id), [1, 2]);
  });

  it("anjaan shape ko chhoota nahi", () => {
    const odd = { status: "success", data: { total: 0 } };
    assert.equal(scopeXspResponse(odd, "A1"), odd);
    assert.equal(scopeXspResponse(null, "A1"), null);
  });
});
