const axios = require("axios");
const { configData } = require("../config");
const templates = require("../requestData/mandateRequestData");
const { memDetails } = require("./euin");

/**
 * Audit #22 — e-NACH / UPI AutoPay, built here from BSE's own templates
 * (requestData/mandateRequestData.js) instead of in the browser.
 *
 * The browser used to post a fully-formed mandate_register payload with a hardcoded member
 * code, an EMPTY UPI ID and fields the templates never had (`redirect_url`, `request_type:
 * "REGISTRATION"`). It now sends intent — mode, UPI ID, limit — and this file decides the rest.
 *
 * What the templates decide, and nothing here is invented:
 *   UPI AutoPay                         registerMandateUPI    type "U", mode "DD", vpa[]
 *   NetBanking / Debit card / Aadhaar   registerMandateEnach  type "X", mode "DD"
 *
 * The three e-mandate channels share one template because BSE's payload has no field that
 * names the channel: the investor picks NetBanking, debit card or Aadhaar on the bank/NPCI
 * page BSE's link opens. Their choice is still stored with the mandate (Laravel `mandates`).
 * NEXT PHASE: confirm on the whitelisted host whether BSE v2 takes a channel field; if it
 * does, it belongs in MODES below and nowhere else.
 *
 * Template keys deliberately NOT sent:
 *   mem_mandate_info.umrn_number / utility_code / sponsor_code / mandate_status_date — they
 *     describe a mandate that already exists at NPCI (a UMRN is issued AFTER approval). A new
 *     registration has none, and the template's values are demo numbers.
 *   investor_bank_details.branch — never held for the investor, and an empty string poisons
 *     a BSE payload (see xsp.js).
 *   mem_details is the server-built execution-only block every order carries (euin.js), never
 *     the template's sample EUIN/ARN.
 */
const MODES = {
  upi: { label: "UPI AutoPay", template: "registerMandateUPI" },
  netbanking: { label: "NetBanking", template: "registerMandateEnach" },
  debit_card: { label: "Debit card", template: "registerMandateEnach" },
  aadhaar: { label: "Aadhaar eSign", template: "registerMandateEnach" },
};

// NPCI's VPA shape — handle@psp. Checked here because an empty or malformed one is what the
// old payload sent, and BSE's answer to that is a rejection the investor cannot read.
const VPA = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const validVpa = (v) => VPA.test(String(v || "").trim());

const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * @param bank  the investor's own account from investor-data (`bank_accounts[0]`), never the
 *              browser's. Account type is "SB": the UCC is registered with SB (addUcc) and a
 *              mandate must debit the same account BSE holds for the investor.
 */
function buildMandateRegisterPayload({ mode, vpa, amount, bank = {}, ucc, memberCode, refId, today = new Date() }) {
  const t = templates[MODES[mode].template].data;
  const until = new Date(today);
  // Same ten-year validity the templates show (2025-03-10 → 2035-03-15).
  until.setFullYear(until.getFullYear() + 10);
  const name = String(bank.bank_name || "").trim();
  return {
    data: {
      investor: { ucc },
      member: String(memberCode),
      mem_details: memDetails(),
      investor_bank_details: {
        ifsc: String(bank.ifsc_code || "").trim().toUpperCase(),
        no: String(bank.account_number || "").trim(),
        type: "SB",
        ...(name ? { name } : {}),
        ...(mode === "upi" ? { vpa: [String(vpa).trim()] } : {}),
      },
      mem_mandate_info: { member_mandate_id: String(refId) },
      amount: Number(amount),
      start_date: isoDay(today),
      valid_till: isoDay(until),
      reg_date: isoDay(today),
      type: t.type,
      mode: t.mode,
      frequency: t.frequency,
      request_type: t.request_type,
    },
  };
}

/** BSE answers with an envelope; the mandate itself is the first item, list row, or `data`. */
const recordOf = (response) => {
  const d = response?.data;
  if (Array.isArray(d?.items) && d.items.length) return d.items[0];
  if (Array.isArray(d?.lists) && d.lists.length) return d.lists[0];
  return d && typeof d === "object" ? d : {};
};

/**
 * The mandate's state in OUR words: pending | approved | rejected | cancelled.
 * Unknown stays "pending" — a mandate is never reported active on a guess, because "active"
 * is what tells an investor their SIP will be debited automatically.
 * NEEDS VERIFICATION on the whitelisted host: BSE's status words for mandate_get.
 */
function mandateState(row = {}) {
  const s = String(row.mandate_status || row.status || "").trim().toUpperCase();
  if (row.cancelled_at || /CANCEL/.test(s)) return "cancelled";
  if (/REJECT|FAIL|EXPIRE/.test(s)) return "rejected";
  if (row.is_verified === true || /^(APPROVED|ACTIVE|VERIFIED)$/.test(s)) return "approved";
  return "pending";
}

// Wherever BSE puts the page the investor must open to approve, it is a URL under a key that
// says link/url/redirect. Read it from the record and from the envelope's data.
const LINKY = /link|url|redirect/i;
function approvalLink(...objs) {
  for (const o of objs) {
    if (!o || typeof o !== "object") continue;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && LINKY.test(k) && /^(https?:\/\/|\/)/i.test(v.trim())) return v.trim();
    }
  }
  return null;
}

/** What a successful mandate_register / mandate_get told us. */
function mandateOutcome(response) {
  const rec = recordOf(response);
  const id = rec.exch_mandate_id ?? rec.mandate_id ?? rec.id ?? null;
  return {
    exch_mandate_id: id == null || id === "" ? null : String(id),
    state: mandateState(rec),
    approval_link: approvalLink(rec, response?.data),
  };
}

// ── Laravel's copy (the `mandates` table) ────────────────────────────────────────────────
// Same transport as consents and stored orders: the investor's own bearer and User-Agent, so
// a row can only ever be filed against the person whose mandate it is. Never throws — the
// mandate lives at BSE; our copy failing to write must not turn a registered mandate into an
// error on screen.
const base = () => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "");
const headersOf = (req) => ({
  authorization: req.headers?.authorization,
  "user-agent": req.headers?.["user-agent"] || "",
  accept: "application/json",
});

async function recordMandate(req, row) {
  if (!req.headers?.authorization) return null;
  try {
    const res = await axios.post(`${base()}/mandates`, row, { timeout: 15000, headers: headersOf(req) });
    return res?.data?.data || null;
  } catch (err) {
    console.error("[mandate] could not record in Laravel:", err.response?.status || err.message);
    return null;
  }
}

async function storedMandates(req) {
  if (!req.headers?.authorization) return [];
  try {
    const res = await axios.get(`${base()}/mandates`, { timeout: 8000, headers: headersOf(req) });
    return Array.isArray(res?.data?.data) ? res.data.data : [];
  } catch (err) {
    console.warn("[mandate] stored mandates unavailable:", err.message);
    return [];
  }
}

module.exports = {
  MODES,
  validVpa,
  buildMandateRegisterPayload,
  mandateState,
  mandateOutcome,
  approvalLink,
  recordMandate,
  storedMandates,
};
