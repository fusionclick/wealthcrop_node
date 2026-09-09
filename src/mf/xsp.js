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

const FREQ = { m: 12, q: 4, w: 52 };
const MAX_INSTALLMENTS = 1200;

const isoDay = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

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

function validateSip(input = {}, { minSip = 500 } = {}) {
  if (!String(input.scheme || "").trim()) return "Choose a fund before starting a SIP";
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a SIP amount";
  if (amount < minSip) return `Minimum SIP for this fund is ₹${minSip}`;
  if (!FREQ[String(input.freq || "m")]) return "Choose a valid SIP frequency";
  const start = isoDay(input.start_date);
  if (!start) return "Choose a SIP start date";
  const day = Number(input.txn_date);
  if (!Number.isInteger(day) || day < 1 || day > 28) return "Choose a SIP date between 1 and 28";
  const installments = Number(input.ninstallments) || installmentsBetween(start, isoDay(input.end_date), String(input.freq || "m"));
  if (!installments) return "Choose a SIP end date after the start date";
  return null;
}

/**
 * @param input  browser intent: scheme, amount, freq, txn_date, start_date, end_date
 * @param ctx    ucc + memberCode from the session, dp/client id from stored KYC, email
 */
function buildXspRegisterPayload(input = {}, { ucc, memberCode, email, dpId, clientId } = {}) {
  const freq = String(input.freq || "m");
  const start = isoDay(input.start_date);
  const end = isoDay(input.end_date);
  const ninstallments =
    Number(input.ninstallments) || installmentsBetween(start, end, freq) || FREQ[freq] || 12;

  // Demat needs a real dp_id + client_id (msgid 1522); without them BSE holds it physically.
  const dp = String(dpId || "").trim();
  const client = String(clientId || "").trim();
  const hasDp = Boolean(dp && client);

  const data = {
    sxp_type: "sip",
    mem_sxp_ref_id: `SIP${Date.now()}`,
    investor: { ucc },
    member: String(memberCode),
    src_scheme: String(input.scheme).trim(),
    amount: Number(input.amount),
    cur: "INR",
    is_fresh: true,
    kyc_passed: true,
    dpc: true,
    phys_or_demat: hasDp ? "D" : "P",
    start_date: start,
    freq,
    txn_date: Number(input.txn_date),
    ninstallments,
    holder: [{ holder_rank: "1", ...(email ? { email } : {}) }],
    ...(email ? { email } : {}),
    ...(end ? { end_date: end } : {}),
    ...(hasDp ? { depository_acct: { depository: "C", dp_id: dp, client_id: client } } : {}),
  };
  return { data };
}

module.exports = { buildXspRegisterPayload, validateSip, installmentsBetween, FREQ };
