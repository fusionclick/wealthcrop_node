// SIP (sxp_register) payload, built here rather than in the browser.
//
// The page used to POST a fully-formed BSE payload — including its own UCC, a hardcoded
// member code, and a blank src_scheme, because the only link into the SIP page passes no
// fund. Every registration therefore failed, and the UCC was whatever the browser said.
// Same treatment as orders: the client sends intent, the server builds the request.
//
// Shape verified one field at a time against the live BSE host from the whitelisted box.
// A registration finally succeeded as sxp_id 202600000125896 with the rules below.
//
//   flat {data:{...}}       An array wrapper (data.sxps[], data.orders[], …) is NOT used
//                           here. It looks accepted only because BSE then reads no fields
//                           at all and reports the first missing one; a deliberately
//                           nonsensical wrapper key behaved identically.
//   ninstallments REQUIRED  Absent or 0 gives `ninstallments_invalid_for_freq` (msgid
//                           3810) even when start_date and end_date are both present.
//   NO mobnum ANYWHERE      sxp_register rejects every number we send with
//                           `invalid`/mobnum (msgid 579) — the investor's real number and
//                           the 9999999999 placeholder alike, though order_new accepts
//                           that same real number. Dropping the field entirely is what
//                           made the call succeed, so mobnum is omitted, not defaulted.
//   txn_date is a NUMBER    As a string the whole request comes back invalid_json.
//   member is a STRING      As a number, likewise invalid_json.
//   freq lowercase          "MONTHLY" gives `invalid`/freq; "m" / "q" / "w".
//   no empty strings        The rule this codebase keeps relearning: "" is not a valid
//                           enum for BSE, and one of them poisons the whole request.
//   start_date's DAY must   `invalid_txn_date` (msgid 3809) otherwise. Verified live:
//   equal txn_date          start 2026-11-10 with txn_date 5 was rejected 62 days out,
//                           while start 2026-10-05 / txn 5, 2026-09-25 / txn 25,
//                           2026-09-15 / txn 15 and even 2026-09-10 / txn 10 (one day
//                           out) all registered. So there is no minimum notice period —
//                           the only rule is that the two agree.

const FREQ = { m: 12, q: 4, w: 52 };
const MAX_INSTALLMENTS = 1200;
// The horizon a fresh SIP opens on in the form (SIPSetupPage seeds `years` at 10). Reused
// when a modify has to invent a term because the registration carries none.
const DEFAULT_SIP_YEARS = 10;

const isoDay = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

/**
 * BSE counts installments, not an end date. The page collects start and end dates because
 * that is what an investor thinks in, so convert — and let an explicit count win if the
 * caller sends one.
 */
function installmentsBetween(start, end, freq) {
  const perYear = FREQ[freq];
  if (!perYear || !start || !end) return null;
  const years = (Date.parse(end) - Date.parse(start)) / (365.25 * 24 * 3600 * 1000);
  if (!Number.isFinite(years) || years <= 0) return null;
  return Math.max(1, Math.min(MAX_INSTALLMENTS, Math.round(years * perYear)));
}

/**
 * ─── SIP, SWP and STP are all one BSE call (tickets 17, 18) ──────────────────────────────
 *
 * The SDK exposes a single /sxp_register and BSE switches on `sxp_type`. So STP and SWP are
 * not new plumbing, they are the same registration with a different type and one or two
 * extra fields — which is why they are built here rather than in three near-identical
 * functions that would drift apart the first time BSE changed a rule.
 *
 *   sip  src_scheme, amount                       money in, on a schedule
 *   swp  src_scheme, src_folio, amount OR units   money out, on a schedule
 *   stp  src_scheme, dest_scheme, src_folio, amt  moved between two schemes, on a schedule
 *
 * A folio is what makes the difference: a SIP creates a holding, while a SWP and an STP
 * take from one that already exists, and an investor can hold the same scheme in several
 * folios. BSE cannot guess which.
 */
const SXP_TYPES = ["sip", "swp", "stp"];
const LABEL = { sip: "SIP", swp: "SWP", stp: "STP" };

const sxpTypeOf = (input = {}) => {
  const t = String(input.sxp_type || input.type || "sip").trim().toLowerCase();
  return SXP_TYPES.includes(t) ? t : null;
};

/**
 * @param opts.minSip     the scheme's own minimum, when known
 * @param opts.available  units the investor actually holds in this folio (SWP/STP only)
 */
function validateSxp(input = {}, { minSip = 500, available = null } = {}) {
  const type = sxpTypeOf(input);
  if (!type) return "Choose a valid instruction type";
  const what = LABEL[type];

  if (!String(input.scheme || "").trim()) return `Choose a fund before starting a ${what}`;
  if (type === "stp" && !String(input.dest_scheme || "").trim()) {
    return "Choose the fund to transfer into";
  }
  if (type === "stp" && String(input.dest_scheme).trim() === String(input.scheme).trim()) {
    return "The source and destination funds must be different";
  }
  // Ticket 18: a withdrawal has to come out of a folio the investor holds. Without one BSE
  // has no way to know which holding to sell from.
  if ((type === "swp" || type === "stp") && !String(input.folio || input.src_folio || "").trim()) {
    return `Choose the folio to ${type === "swp" ? "withdraw from" : "transfer from"}`;
  }

  const byUnits = input.isunits === true || input.all_units === true;
  if (byUnits) {
    if (input.all_units !== true) {
      const units = Number(input.units);
      if (!Number.isFinite(units) || units <= 0) return "Enter how many units to withdraw";
      if (available != null && units > available) {
        return `You hold ${available} units in this folio. Withdraw that or less.`;
      }
    }
  } else {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return `Enter a ${what} amount`;
    // The scheme minimum is a purchase floor. A withdrawal is not buying anything, so it
    // does not apply — BSE enforces its own SWP/STP minimums from systematic[].
    if (type === "sip" && amount < minSip) return `Minimum SIP for this fund is ₹${minSip}`;
  }

  if (!FREQ[String(input.freq || "m")]) return `Choose a valid ${what} frequency`;
  const start = isoDay(input.start_date);
  if (!start) return `Choose a ${what} start date`;
  const day = Number(input.txn_date);
  if (!Number.isInteger(day) || day < 1 || day > 28) return `Choose a ${what} date between 1 and 28`;
  // BSE ties the two together (msgid 3809). The form keeps them in step, so this is the
  // backstop for anything that posts them out of step.
  if (Number(start.slice(8, 10)) !== day) {
    return `${what} date and start date must be the same day of the month — start on the ${day}${ordinal(day)}`;
  }
  const installments = Number(input.ninstallments) || installmentsBetween(start, isoDay(input.end_date), String(input.freq || "m"));
  if (!installments) return `Choose a ${what} end date after the start date`;
  return null;
}

// The name this codebase already calls everywhere. A SIP is the default type, so the old
// signature keeps working unchanged.
const validateSip = (input, opts) => validateSxp({ sxp_type: "sip", ...input }, opts);

/**
 * @param input  browser intent: sxp_type, scheme, dest_scheme, folio, amount/units, freq,
 *               txn_date, start_date, end_date
 * @param ctx    ucc + memberCode from the session, dp/client id from stored KYC, email
 */
function buildXspRegisterPayload(input = {}, { ucc, memberCode, email, dpId, clientId } = {}) {
  const type = sxpTypeOf(input) || "sip";
  const freq = String(input.freq || "m");
  const start = isoDay(input.start_date);
  const end = isoDay(input.end_date);
  const ninstallments =
    Number(input.ninstallments) || installmentsBetween(start, end, freq) || FREQ[freq] || 12;

  // Demat needs a real dp_id + client_id (msgid 1522); without them BSE holds it physically.
  const dp = String(dpId || "").trim();
  const client = String(clientId || "").trim();
  const hasDp = Boolean(dp && client);

  const folio = String(input.folio || input.src_folio || "").trim();
  const byUnits = input.isunits === true || input.all_units === true;

  const data = {
    sxp_type: type,
    mem_sxp_ref_id: `${LABEL[type]}${Date.now()}`,
    investor: { ucc },
    member: String(memberCode),
    src_scheme: String(input.scheme).trim(),
    ...(type === "stp" ? { dest_scheme: String(input.dest_scheme).trim() } : {}),
    // Never an empty string — "" is not a valid value anywhere in this API, and one of them
    // poisons the whole request.
    ...(folio ? { src_folio: folio } : {}),
    ...(byUnits
      ? { isunits: true, all_units: input.all_units === true, ...(input.all_units === true ? {} : { units: Number(input.units) }) }
      : { amount: Number(input.amount), cur: "INR" }),
    is_fresh: true,
    kyc_passed: true,
    dpc: true,
    phys_or_demat: hasDp ? "D" : "P",
    start_date: start,
    freq,
    // Taken from start_date, not from the caller: BSE rejects the pair when they disagree
    // (invalid_txn_date, 3809), so deriving it makes that impossible rather than merely
    // validated. validateSxp still reports the mismatch so the investor sees why.
    txn_date: Number(start.slice(8, 10)),
    ninstallments,
    holder: [{ holder_rank: "1", ...(email ? { email } : {}) }],
    ...(email ? { email } : {}),
    ...(end ? { end_date: end } : {}),
    ...(hasDp ? { depository_acct: { depository: "C", dp_id: dp, client_id: client } } : {}),
    // ── No mem_details here, and that is a finding, not an omission ──────────────────────
    // A SIP registration ought to carry the same execution-only declaration a one-off order
    // does. BSE StarMF v2 has nowhere to put it. Probed live against the exchange on
    // 2026-09-24, one variant at a time:
    //
    //   mem_details {euin_flag:true}        -> 579 invalid, field "euin_flag"
    //   mem_details {euin:"", euin_flag:true} -> 579 invalid, field "euin_flag"
    //   mem_details {euin_flag:"Y"}         -> 1581 invalid_json
    //   mem_details {}                      -> passes shape, reaches the business rule
    //   euin_flag at the TOP level          -> passes shape... and so does "banana",
    //                                          i.e. it is ignored, not accepted
    //
    // So sending it breaks every registration (one bad field poisons the whole request) and
    // the only shape that survives carries no declaration anyway. The consent is captured
    // and stored in our own eight-year trail instead (see Backend/src/mf/consent.js), which
    // is what §4.1 asks for; the exchange-side declaration rides on order_new, where it is
    // accepted. Flagged to the client: BSE must expose the field on sxp_register for the
    // registration itself to be declared.
  };
  return { data };
}

/**
 * ─── Managing a SIP that already exists (tickets 19, 20, 21) ────────────────────────────
 *
 * Every one of these used to be `req.body` forwarded to BSE untouched, with a hardcoded
 * demo payload substituted when the body was empty. That is the same hole bindUcc closes
 * for orders, and worse here: nothing checked that the reg_no belonged to the caller, so
 * any signed-in investor could cancel, pause or top up **anyone's** SIP by guessing one.
 * The ownership check lives in the controller (it needs a BSE round trip); these functions
 * build the payloads, so a caller can no longer name fields BSE should not hear from a
 * browser.
 *
 * Field names are BSE's own, from requestData/xspRequestData.js. Note topup uses `reg_num`
 * where every sibling call uses `reg_no` — not a typo here.
 */

// BSE spells the registration id several ways across sxp_list / sxp_get. Read them all.
const xspRegNo = (row = {}) =>
  String(row.reg_no ?? row.reg_num ?? row.sxp_id ?? row.id ?? "").trim();

// sxp_cancel reason codes. 6 is "cancelled by investor", the only one this product has a
// mandate for — the rest are member/AMC-initiated and are not ours to send.
const CANCEL_BY_INVESTOR = 6;

function buildCancelXspPayload(regNo, { reason = "", sxpType = "SIP" } = {}) {
  return {
    data: {
      reg_no: String(regNo),
      reason_cd: CANCEL_BY_INVESTOR,
      // BSE rejects an empty string as an enum value all over this API, but reason_cd_msg
      // is free text — the demo payload sends "". Kept only when the investor typed one.
      ...(String(reason).trim() ? { reason_cd_msg: String(reason).trim().slice(0, 200) } : {}),
      sxp_type: String(sxpType).toUpperCase(),
    },
  };
}

function buildPauseXspPayload(regNo, { installments, from } = {}) {
  const n = Number(installments);
  const day = isoDay(from);
  return {
    data: {
      reg_no: String(regNo),
      ninstallments: Number.isInteger(n) && n > 0 ? n : 1,
      ...(day ? { paused_from: day } : {}),
    },
  };
}

function buildResumeXspPayload(regNo, { reason = "" } = {}) {
  return {
    data: {
      reg_no: String(regNo),
      resume_reason: String(reason).trim().slice(0, 200) || "Resumed by investor",
    },
  };
}

/**
 * Ticket 19 — Top-Up.
 *
 * A BSE top-up is its own dated, recurring instruction (its own amount, frequency and
 * dates) layered on the registration; it is not an edit of the parent SIP's amount. So the
 * parent's amount, dates and frequency are never touched here — which is exactly what
 * "existing SIP details must remain unchanged except for the configured Top-Up" asks for.
 */
function buildTopupXspPayload(regNo, input = {}, { email } = {}) {
  const start = isoDay(input.start_date);
  const end = isoDay(input.end_date);
  return {
    data: {
      reg_num: String(regNo), // reg_num, not reg_no — BSE's spelling on this endpoint only
      mem_sxp_ref_id: `TOP${Date.now()}`,
      amount: Number(input.amount),
      cur: "INR",
      ...(start ? { start_date: start } : {}),
      ...(end ? { end_date: end } : {}),
      freq: String(input.freq || "y"),
      ...(start ? { txn_date: Number(start.slice(8, 10)) } : {}),
      ...(String(input.remark || "").trim() ? { remark: String(input.remark).trim().slice(0, 200) } : {}),
      first_order_today: false,
      // No mobnum. sxp_register rejects every number we send (msgid 579); the top-up
      // endpoint is the same family and there is no reason to find out the hard way.
      ...(email ? { email } : {}),
    },
  };
}

/**
 * @param limits {minAmount,maxAmount,multiple} from the scheme's own systematic[] SIP row,
 *               which is where BSE publishes them. Omitted fields simply are not checked —
 *               inventing a floor is what ticket 3 was about.
 */
function validateTopup(input = {}, limits = {}) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a top-up amount";
  const { minAmount, maxAmount, multiple } = limits;
  if (minAmount != null && amount < minAmount) return `Minimum top-up for this fund is ₹${minAmount}`;
  if (maxAmount != null && amount > maxAmount) return `Maximum top-up for this fund is ₹${maxAmount}`;
  if (multiple != null && multiple > 0 && amount % multiple !== 0) {
    return `Top-up must be in multiples of ₹${multiple}`;
  }
  const freq = String(input.freq || "y");
  // BSE's top-up frequencies are yearly and half-yearly on top of the SIP's own cadence.
  if (!["y", "h", "m", "q"].includes(freq)) return "Choose a valid top-up frequency";
  if (input.start_date && !isoDay(input.start_date)) return "Choose a valid top-up start date";
  if (input.end_date && !isoDay(input.end_date)) return "Choose a valid top-up end date";
  return null;
}

/**
 * Ticket 21 — Modification.
 *
 * BSE has no sxp_update: a SIP's amount, date and frequency cannot be edited in place. The
 * only faithful implementation is register-the-new-one, then cancel-the-old-one — in that
 * order. Cancel-first would mean a failed registration leaves the investor with no SIP at
 * all, while this way a failed cancel leaves them with two, which is visible on the SIPs
 * page and reversible. "Existing SIP data must not be corrupted" decides the order.
 *
 * Returns the intent for the replacement registration: the old SIP's values with the
 * investor's changes on top, so an unspecified field carries over rather than resetting.
 */
function mergeSipChanges(existing = {}, changes = {}) {
  const pick = (a, b) => (a === undefined || a === null || a === "" ? b : a);
  const freq = String(pick(changes.freq, existing.freq || "m")).toLowerCase();
  const start = isoDay(changes.start_date) || null;

  // A modify re-registers the SIP, so its start date moves to the next valid occurrence —
  // always in the future. Carrying the old end date across then described a term that had
  // already run out: `installmentsBetween` returned 0 and every modify was refused with
  // "Choose a SIP end date after the start date", for a field the investor was never shown.
  // An end date that no longer sits after the start is stale data, not an instruction.
  const carriedEnd = isoDay(changes.end_date) || isoDay(existing.end_date) || null;
  const end = carriedEnd && (!start || carriedEnd > start) ? carriedEnd : null;

  // Dropping the stale end date was only half of it: a registration that records no
  // instalment count either then has NO term at all, `validateSxp` computes 0 instalments,
  // and the modify is refused with the very message that was supposed to be fixed.
  //
  // The investor is not asked for a term here — the modify form offers amount, date and
  // frequency, nothing else — so refusing them over a field they were never shown is the
  // wrong answer. Carry the registration's own count when it has one; otherwise open on the
  // same horizon a brand new SIP does, which is what the fresh-SIP form already defaults to.
  const carriedCount = Number(pick(changes.ninstallments, existing.ninstallments)) || null;
  const ninstallments = carriedCount || (end ? null : (FREQ[freq] || FREQ.m) * DEFAULT_SIP_YEARS);

  return {
    scheme: String(pick(changes.scheme, existing.src_scheme || existing.scheme || "")).trim(),
    amount: Number(pick(changes.amount, existing.amount)),
    freq,
    start_date: start,
    // txn_date follows start_date; BSE rejects the pair when they disagree (msgid 3809).
    txn_date: start ? Number(start.slice(8, 10)) : Number(pick(changes.txn_date, existing.txn_date)),
    end_date: end,
    ninstallments,
  };
}

module.exports = {
  buildXspRegisterPayload,
  validateSip,
  validateSxp,
  sxpTypeOf,
  SXP_TYPES,
  installmentsBetween,
  FREQ,
  xspRegNo,
  buildCancelXspPayload,
  buildPauseXspPayload,
  buildResumeXspPayload,
  buildTopupXspPayload,
  validateTopup,
  mergeSipChanges,
  CANCEL_BY_INVESTOR,
};
