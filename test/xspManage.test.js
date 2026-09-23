const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  xspRegNo,
  buildCancelXspPayload,
  buildPauseXspPayload,
  buildResumeXspPayload,
  buildTopupXspPayload,
  validateTopup,
  validateSip,
  mergeSipChanges,
  CANCEL_BY_INVESTOR,
} = require("../src/mf/xsp");
// Read from the source of truth: a hardcoded pair went stale the moment the AMFI consent
// matrix added three keys, and a fixture easier to satisfy than production hides the gap.
const { REQUIRED_ACKS } = require("../src/mf/suitability");
const controller = require("../src/controllers/StarMFController");

// ── payload shapes ────────────────────────────────────────────────────────────────────

describe("manage-a-SIP payloads", () => {
  it("cancel sends BSE's investor reason code, and no empty-string enum", () => {
    const { data } = buildCancelXspPayload("reg-1");
    assert.equal(data.reg_no, "reg-1");
    assert.equal(data.reason_cd, CANCEL_BY_INVESTOR);
    assert.equal(data.sxp_type, "SIP");
    // "" is not a valid value anywhere in this API — the field is omitted, not blanked.
    assert.equal("reason_cd_msg" in data, false);
    assert.equal(buildCancelXspPayload("reg-1", { reason: "Too costly" }).data.reason_cd_msg, "Too costly");
  });

  it("top-up uses reg_num, which is BSE's spelling on that endpoint alone", () => {
    const { data } = buildTopupXspPayload("reg-9", { amount: 1000, freq: "y", start_date: "2026-03-02" });
    assert.equal(data.reg_num, "reg-9");
    assert.equal(data.reg_no, undefined, "reg_no here would silently top up nothing");
    assert.equal(data.amount, 1000);
    // txn_date follows start_date, same rule as registration (msgid 3809).
    assert.equal(data.txn_date, 2);
    assert.equal(typeof data.txn_date, "number", "as a string the whole request is invalid_json");
    assert.equal("mobnum" in data, false, "sxp_register rejects every mobnum we send (msgid 579)");
  });

  it("pause defaults to one installment rather than sending a blank count", () => {
    assert.equal(buildPauseXspPayload("reg-1").data.ninstallments, 1);
    assert.equal(buildPauseXspPayload("reg-1", { installments: 3 }).data.ninstallments, 3);
    assert.equal(buildPauseXspPayload("reg-1", { installments: -2 }).data.ninstallments, 1);
    assert.equal("paused_from" in buildPauseXspPayload("reg-1").data, false);
    assert.equal(buildPauseXspPayload("reg-1", { from: "2026-02-24" }).data.paused_from, "2026-02-24");
  });

  it("resume always carries a reason string", () => {
    assert.equal(buildResumeXspPayload("reg-1").data.resume_reason, "Resumed by investor");
    assert.equal(buildResumeXspPayload("reg-1", { reason: "back on track" }).data.resume_reason, "back on track");
  });

  it("reads BSE's several spellings of the registration id", () => {
    assert.equal(xspRegNo({ reg_no: "a" }), "a");
    assert.equal(xspRegNo({ reg_num: "b" }), "b");
    assert.equal(xspRegNo({ sxp_id: "c" }), "c");
    assert.equal(xspRegNo({}), "");
  });
});

// ── ticket 19: top-up limits ──────────────────────────────────────────────────────────

describe("ticket 19: top-up validation", () => {
  it("respects the scheme's own published minimum", () => {
    assert.equal(validateTopup({ amount: 500 }, { minAmount: 1000 }), "Minimum top-up for this fund is ₹1000");
    assert.equal(validateTopup({ amount: 1000 }, { minAmount: 1000 }), null);
  });

  it("respects a maximum and a multiple when the scheme published them", () => {
    assert.match(validateTopup({ amount: 99999 }, { maxAmount: 50000 }), /Maximum/);
    assert.match(validateTopup({ amount: 1500 }, { multiple: 1000 }), /multiples of ₹1000/);
    assert.equal(validateTopup({ amount: 2000 }, { multiple: 1000 }), null);
  });

  it("an unpublished limit is not checked, never replaced with an invented floor", () => {
    assert.equal(validateTopup({ amount: 1 }, {}), null);
  });

  it("rejects a missing amount and an unsupported frequency", () => {
    assert.match(validateTopup({}, {}), /Enter a top-up amount/);
    assert.match(validateTopup({ amount: -5 }, {}), /Enter a top-up amount/);
    assert.match(validateTopup({ amount: 1000, freq: "x" }, {}), /valid top-up frequency/);
  });
});

// ── ticket 21: merging a modification ─────────────────────────────────────────────────

describe("ticket 21: merging changes onto the existing SIP", () => {
  const existing = {
    src_scheme: "8130-GR",
    amount: 5000,
    freq: "m",
    txn_date: 5,
    end_date: "2030-01-05",
    ninstallments: 60,
  };

  it("an unspecified field carries over instead of resetting", () => {
    const merged = mergeSipChanges(existing, { amount: 7500 });
    assert.equal(merged.amount, 7500);
    assert.equal(merged.scheme, "8130-GR");
    assert.equal(merged.freq, "m");
    assert.equal(merged.end_date, "2030-01-05");
  });

  it("txn_date follows a new start date — BSE rejects the pair when they disagree", () => {
    const merged = mergeSipChanges(existing, { start_date: "2026-11-21" });
    assert.equal(merged.start_date, "2026-11-21");
    assert.equal(merged.txn_date, 21, "a start of the 21st with txn_date 5 is msgid 3809");
  });

  it("an empty string is treated as 'not supplied', not as a value", () => {
    const merged = mergeSipChanges(existing, { freq: "", scheme: "" });
    assert.equal(merged.freq, "m");
    assert.equal(merged.scheme, "8130-GR");
  });
});

// ── the shared ownership guard ────────────────────────────────────────────────────────

const MINE = {
  reg_no: "REG-MINE",
  ucc: "UCC-A",
  sxp_type: "SIP",
  status: "active",
  src_scheme: "8130-GR",
  amount: 5000,
  freq: "m",
  txn_date: 5,
  start_date: "2025-01-05",
  end_date: "2030-01-05",
  ninstallments: 60,
};
const THEIRS = { ...MINE, reg_no: "REG-THEIRS", ucc: "UCC-B" };

const fakeRes = () => {
  const out = { code: 200, body: null };
  return {
    out,
    json: (b) => {
      out.body = b;
      return out;
    },
    status: (c) => {
      out.code = c;
      return {
        json: (b) => {
          out.body = b;
          return out;
        },
      };
    },
  };
};

// A modification registers a fresh SIP, so it goes through the same ticket-22 disclaimer
// and ticket-24 suitability gates a purchase does. Every request here carries both.
const reqFor = (data) => ({
  ucc: "UCC-A",
  investor: { email: "a@example.com", kyc: {}, riskProfile: { profile: "Aggressive" } },
  body: { data: { acknowledged: REQUIRED_ACKS, ...data } },
});

describe("every manage-a-SIP endpoint refuses a SIP that is not the caller's", () => {
  let sent;

  beforeEach(() => {
    sent = [];
    // Both BSE lists carry both investors' rows. scopeXspResponse is what narrows them, so
    // this is the real shape of the hole: BSE itself will happily return and act on
    // somebody else's registration.
    controller.callTrxn = async (method, reqObj) => {
      sent.push({ method, reqObj });
      if (method === "getAllXsp") return { status: "success", data: { lists: [MINE, THEIRS] } };
      return { status: "success", data: { ok: true } };
    };
    controller.handleTrxnRequest = async (method, reqObj, res) => {
      sent.push({ method, reqObj });
      return res.json({ status: "success", data: { ok: true } });
    };
    controller.sipLimitsFor = async () => ({ minAmount: 1000 });
  });

  for (const name of ["cancelXsp", "pauseXsp", "resumeXsp", "topupXsp", "getXsp", "getXspTrxnHistory", "modifyXsp"]) {
    it(`${name}: another investor's reg_no is a 404, and nothing reaches BSE`, async () => {
      const res = fakeRes();
      await controller[name](reqFor({ reg_no: "REG-THEIRS", amount: 2000 }), res);
      assert.equal(res.out.code, 404);
      assert.equal(sent.filter((c) => c.method !== "getAllXsp").length, 0, `${name} still called BSE`);
    });

    it(`${name}: a missing reg_no is a 400, not a hardcoded demo registration`, async () => {
      const res = fakeRes();
      await controller[name](reqFor({ amount: 2000 }), res);
      assert.equal(res.out.code, 400);
      assert.equal(sent.filter((c) => c.method !== "getAllXsp").length, 0);
    });
  }

  it("cancelXsp: the caller's own active SIP goes through with the investor reason code", async () => {
    const res = fakeRes();
    await controller.cancelXsp(reqFor({ reg_no: "REG-MINE" }), res);
    assert.equal(res.out.code, 200);
    const call = sent.find((c) => c.method === "cancelXsp");
    assert.ok(call, "the cancel never reached BSE");
    assert.equal(call.reqObj.data.reg_no, "REG-MINE");
    assert.equal(call.reqObj.data.reason_cd, CANCEL_BY_INVESTOR);
  });

  it("ticket 20: an already-cancelled SIP is refused before BSE sees it", async () => {
    controller.callTrxn = async (method) => {
      if (method === "getAllXsp") {
        return { status: "success", data: { lists: [{ ...MINE, status: "cancelled" }] } };
      }
      return { status: "success" };
    };
    const res = fakeRes();
    await controller.cancelXsp(reqFor({ reg_no: "REG-MINE" }), res);
    assert.equal(res.out.code, 409);
    assert.match(res.out.body.message, /already cancelled/i);
  });

  it("ticket 19: a top-up under the scheme minimum is rejected server-side", async () => {
    const res = fakeRes();
    await controller.topupXsp(reqFor({ reg_no: "REG-MINE", amount: 100 }), res);
    assert.equal(res.out.code, 400);
    assert.match(res.out.body.message, /Minimum top-up/);
    assert.equal(sent.some((c) => c.method === "topupXsp"), false);
  });
});

describe("ticket 21: modification never leaves the investor with no SIP", () => {
  const baseCalls = (registerFails, cancelFails) => {
    const sent = [];
    controller.callTrxn = async (method, reqObj) => {
      sent.push({ method, reqObj });
      if (method === "getAllXsp") return { status: "success", data: { lists: [MINE] } };
      if (method === "xspRegister") {
        return registerFails ? { _status: 400, message: "BSE said no" } : { status: "success", data: { sxp_id: "NEW-1" } };
      }
      if (method === "cancelXsp") {
        return cancelFails ? { _status: 500, message: "BSE said no" } : { status: "success" };
      }
      return { status: "success" };
    };
    controller.sipLimitsFor = async () => ({ minAmount: 1000 });
    return sent;
  };

  it("registers the replacement BEFORE cancelling the original", async () => {
    const sent = baseCalls(false, false);
    const res = fakeRes();
    await controller.modifyXsp(reqFor({ reg_no: "REG-MINE", amount: 7500, start_date: "2026-11-05" }), res);
    assert.equal(res.out.code, 200);
    const order = sent.map((c) => c.method).filter((m) => m === "xspRegister" || m === "cancelXsp");
    assert.deepEqual(order, ["xspRegister", "cancelXsp"], "cancel-first would risk leaving no SIP at all");
    assert.equal(res.out.body.data.cancelled_reg_no, "REG-MINE");
  });

  it("a failed registration leaves the original SIP untouched", async () => {
    const sent = baseCalls(true, false);
    const res = fakeRes();
    await controller.modifyXsp(reqFor({ reg_no: "REG-MINE", amount: 7500, start_date: "2026-11-05" }), res);
    assert.equal(res.out.code, 400);
    assert.equal(sent.some((c) => c.method === "cancelXsp"), false, "the original must not be cancelled");
    assert.match(res.out.body.message, /unchanged/i);
  });

  it("a failed cancel is reported as partial, never as success", async () => {
    baseCalls(false, true);
    const res = fakeRes();
    await controller.modifyXsp(reqFor({ reg_no: "REG-MINE", amount: 7500, start_date: "2026-11-05" }), res);
    assert.equal(res.out.code, 207);
    assert.equal(res.out.body.status, "partial");
    // The investor is now on two SIPs; silence here means being debited twice.
    assert.match(res.out.body.message, /debited twice/i);
    assert.equal(res.out.body.data.old_reg_no, "REG-MINE");
  });

  it("the merged SIP is validated before anything is registered", async () => {
    const sent = baseCalls(false, false);
    const res = fakeRes();
    // Start date on the 21st, SIP date left at the existing 5th: mergeSipChanges makes the
    // two agree, so this passes. An amount under the scheme minimum must not.
    await controller.modifyXsp(reqFor({ reg_no: "REG-MINE", amount: 10, start_date: "2026-11-05" }), res);
    assert.equal(res.out.code, 400);
    assert.equal(sent.some((c) => c.method === "xspRegister"), false);
  });
});

describe("modify keeps a SIP running instead of refusing it", () => {
  // QA: every modify of an existing SIP came back "Choose a SIP end date after the start
  // date" — for a field the modify form never shows. A modify re-registers the SIP, so its
  // start moves into the future, and the old end date carried across then described a term
  // that had already run out.
  it("does not inherit an end date the new start has already passed", () => {
    const merged = mergeSipChanges(
      { src_scheme: "PP001ZG-GR", amount: 5000, freq: "m", txn_date: 10, end_date: "2026-01-10" },
      { amount: 7000, start_date: "2026-10-10" }
    );

    assert.equal(merged.end_date, null, "a term that ended before the new start is stale, not an instruction");
    assert.equal(merged.amount, 7000);
    assert.equal(merged.start_date, "2026-10-10");
    assert.equal(merged.txn_date, 10);
  });

  it("keeps an end date that is still ahead of the new start", () => {
    const merged = mergeSipChanges(
      { src_scheme: "PP001ZG-GR", amount: 5000, freq: "m", end_date: "2030-01-10" },
      { amount: 7000, start_date: "2026-10-10" }
    );
    assert.equal(merged.end_date, "2030-01-10");
  });

  // QA round 6: dropping the stale end date was only half of it. A registration with no
  // instalment count then had NO term at all, validateSxp computed 0, and the modify was
  // refused with the very message the previous fix was supposed to remove.
  it("a registration with neither an end date nor a count still gets a term", () => {
    const merged = mergeSipChanges(
      { src_scheme: "PP001ZG-GR", amount: 5000, freq: "m" },
      { amount: 7000, start_date: "2026-10-10" }
    );

    assert.equal(merged.end_date, null);
    assert.equal(merged.ninstallments, 120, "10 years monthly — what a fresh SIP opens on");
    // And the whole point: this now passes the validator instead of being refused.
    assert.equal(validateSip(merged), null);
  });

  it("the registration's own instalment count wins over the default", () => {
    const merged = mergeSipChanges(
      { src_scheme: "PP001ZG-GR", amount: 5000, freq: "m", ninstallments: 36 },
      { amount: 7000, start_date: "2026-10-10" }
    );
    assert.equal(merged.ninstallments, 36);
    assert.equal(validateSip(merged), null);
  });

  it("a quarterly SIP gets a quarterly term, not a monthly one", () => {
    const merged = mergeSipChanges(
      { src_scheme: "PP001ZG-GR", amount: 5000, freq: "q" },
      { amount: 7000, start_date: "2026-10-10" }
    );
    assert.equal(merged.ninstallments, 40, "10 years at 4 a year");
  });

  it("a live end date is still used, and no count is invented over it", () => {
    const merged = mergeSipChanges(
      { src_scheme: "PP001ZG-GR", amount: 5000, freq: "m", end_date: "2030-01-10" },
      { amount: 7000, start_date: "2026-10-10" }
    );
    assert.equal(merged.end_date, "2030-01-10");
    assert.equal(merged.ninstallments, null, "the dates describe the term");
    assert.equal(validateSip(merged), null);
  });
});


// ── ticket 22: the SWP takes the disclaimer gate, the exit does not ───────────────────

describe("ticket 22: registering a SWP requires the acknowledgement", () => {
  // A SWP is not a buy, so ticket 24's suitability gate stays off it — an investor whose
  // profile no longer fits the fund must still be able to schedule their way out. But it
  // IS a considered act set up in advance, so ticket 22 applies, and the one-off redemption
  // remains available if /disclaimers is down.
  const swp = (over = {}, dataOver = {}) => ({
    ucc: "UCC-A",
    investor: { email: "a@example.com", kyc: {}, riskProfile: null },
    body: {
      data: {
        sxp_type: "swp",
        scheme: "PP001ZG-GR",
        folio: "F123",
        amount: 2000,
        freq: "m",
        txn_date: 10,
        start_date: "2026-11-10",
        end_date: "2027-11-10",
        acknowledged: REQUIRED_ACKS,
        ...over,
      },
      ...dataOver,
    },
  });

  let sent;
  beforeEach(() => {
    sent = [];
    controller.unitsHeld = async () => 900;
    controller.callTrxn = async (method, reqObj) => {
      sent.push({ method, reqObj });
      return { status: "success", data: { sxp_id: "SWP-1" } };
    };
  });

  it("refuses an unacknowledged SWP before BSE is called", async () => {
    const res = fakeRes();
    await controller.xspRegister(swp({ acknowledged: undefined }), res);
    assert.equal(res.out.code, 403);
    assert.equal(res.out.body.code, "disclaimer_not_acknowledged");
    assert.equal(sent.some((c) => c.method === "xspRegister"), false, "BSE was called anyway");
  });

  it("lets an acknowledged SWP past both gates with no risk profile at all", async () => {
    // Proves the split: the disclaimer gate ran and was satisfied, the suitability gate
    // never ran — riskProfile is null, which refuses a purchase outright (ticket 24).
    // Only the gate verdict is asserted: what happens after it is BSE's leg, and this
    // suite has no BSE to reach.
    const res = fakeRes();
    await controller.xspRegister(swp(), res);
    assert.notEqual(res.out.code, 403, "an acknowledged SWP must not be refused by a gate");
    assert.notEqual(res.out.body?.code, "disclaimer_not_acknowledged");
  });
});
