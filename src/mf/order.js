const { isTransactable, allowedModes, schemeTransactions } = require("./scheme");
const { memDetails } = require("./euin");

const ALLOWED_TYPES = new Set(["p", "r", "sw"]);

function investorUcc(investor) {
  const ucc = String(investor?.kyc?.ucc_code || investor?.kyc?.ucc || "").trim();
  if (ucc) return ucc;
  // ponytail: test account — same email as Laravel forgot-PIN bypass. USRWC003 ko
  // BSE ne PENDING_VERIFICATION par atka diya aur wahan order lena band kar diya;
  // USRWC56442 APPROVED hai. Asli fix user_kycs.ucc_code bharna hai, ye sirf tab
  // chalta hai jab wo column khali ho.
  if (String(investor?.email || "").toLowerCase() === "rminhal783@gmail.com") return "USRWC56442";
  return "";
}

// ponytail: BSE sirf 10-digit Indian mobile leta hai — +91, spaces, leading 0 sab reject hote hain.
// Khali string ka matlab "koi valid number nahi"; caller usay 400 bana deta hai.
function normalizeMobile(raw) {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
  const ten = digits.length > 10 && digits.startsWith("91") ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : "";
}

// ponytail: signup ab sirf email leta hai, par BSE har order par ek 10-digit mobile
// mangta hai — is liye placeholder. Ceiling: BSE ka SMS/2FA is number par jayega,
// koi user use nahi kar sakta. Jis din profile mein number wapas aaye, ye fallback
// hata do aur caller ko 400 dene do.
const BSE_PLACEHOLDER_MOBILE = "9999999999";

function investorMobile(investor) {
  const own = normalizeMobile(investor?.phone || investor?.mobile || investor?.mobnum);
  if (own) return own;
  if (String(investor?.email || "").toLowerCase() === "rminhal783@gmail.com") return "8617029131";
  return BSE_PLACEHOLDER_MOBILE;
}

function requestedUcc(body = {}) {
  return String(
    body?.data?.orders?.[0]?.investor?.ucc ||
      body?.data?.investor?.ucc ||
      body?.data?.ucc ||
      body?.ucc ||
      ""
  ).trim();
}

function uccMatches(investor, body) {
  const expected = investorUcc(investor);
  const got = requestedUcc(body);
  if (!expected) return { ok: false, error: "KYC UCC is missing. Complete KYC before transacting." };
  if (got && got !== expected) return { ok: false, error: "UCC does not match the logged-in investor." };
  return { ok: true, ucc: expected };
}

function bindUcc(reqObj, ucc, memberCode) {
  const out = reqObj && typeof reqObj === "object" ? reqObj : { data: {} };
  if (!out.data) out.data = {};
  if (Array.isArray(out.data.orders)) {
    out.data.orders = out.data.orders.map((o) => ({
      ...o,
      investor: { ...(o.investor || {}), ucc },
      member: memberCode,
    }));
  }
  if (out.data.investor) out.data.investor = { ...out.data.investor, ucc };
  if (out.data.ucc != null) out.data.ucc = ucc;
  if (Array.isArray(out.data.order_ids) && out.data.investor) {
    out.data.investor.ucc = ucc;
  }
  return out;
}

function validateOrder(body) {
  const orders = body?.data?.orders;
  if (!body || !body.data || !Array.isArray(orders) || !orders.length) {
    return { ok: false, error: "Order payload is required" };
  }
  const order = orders[0];
  const type = String(order.type || "").toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    return { ok: false, error: "Order type must be p (purchase), r (redeem) or sw (switch)" };
  }
  if (!String(order.scheme || "").trim()) {
    return { ok: false, error: "Scheme code is required" };
  }
  const allUnits = !!order.all_units;
  const amount = Number(order.amount || 0);
  if (type === "p" && !(amount > 0)) {
    return { ok: false, error: "Purchase amount must be greater than 0" };
  }
  // Switch bhi redeem hi hai — units ek folio se bahar jaati hain, sirf destination extra hai.
  if (type !== "p" && !allUnits && !(amount > 0)) {
    return { ok: false, error: `Enter a ${type === "sw" ? "switch" : "redemption"} amount or select all units` };
  }
  if (type !== "p" && !String(order.folio || "").trim()) {
    return { ok: false, error: `Folio is required for ${type === "sw" ? "a switch" : "redemption"}` };
  }
  if (type === "sw" && !String(order.dest_scheme || "").trim()) {
    return { ok: false, error: "Destination scheme is required for a switch" };
  }
  return { ok: true, type, order };
}

/**
 * @param platformFloor QA 13.7 — the admin's own Min Lumpsum, applied ON TOP of the
 *   scheme's. Zero (the default, and what an unreachable Laravel yields) means no house
 *   rule, which is exactly how this behaved while the setting had no consumer at all.
 */
function checkSchemeLimits(order, scheme, platformFloor = 0) {
  if (!scheme) return { ok: false, error: "Scheme not found or not transactable" };
  const type = String(order.type || "").toLowerCase();
  if (type === "p" && !isTransactable(scheme)) {
    return { ok: false, error: "This scheme is not open for purchase" };
  }
  // BSE nests its money rules inside lumpsum[] — `min_lumpsum_amount`/`min_amt`/`minLumpsum`
  // are fields it has NEVER sent, so `min` was always 0 and this guard has never once
  // fired. Every under-minimum order went to BSE and came back as a cryptic rejection.
  // schemeTransactions reads the real numbers, and still tolerates an already-mapped row.
  const txns = schemeTransactions(scheme);
  const floor = (row, mapped) => {
    const v = Number(row?.minAmount ?? mapped ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };

  if (type === "p") {
    // The house floor never lowers the AMC's — whichever is higher wins.
    const min = Math.max(floor(txns.lumpsum, scheme.minLumpsum), Number(platformFloor) || 0);
    if (min && Number(order.amount) < min) {
      return { ok: false, error: `Minimum investment is ₹${min}` };
    }
    const max = Number(txns.lumpsum?.maxAmount ?? 0);
    if (max && Number(order.amount) > max) {
      return { ok: false, error: `Maximum investment for this scheme is ₹${max}` };
    }
  }
  if (type === "r" && !order.all_units) {
    const min = floor(txns.redemption, scheme.minRedeem);
    if (min && Number(order.amount) < min) {
      return { ok: false, error: `Minimum redemption is ₹${min}` };
    }
  }
  return { ok: true };
}

/**
 * Audit #46 — the rules a switch must meet before it reaches BSE. Both arguments are BSE
 * master rows from lookupScheme.
 *
 * A switch moves money between two schemes of the SAME fund house; across AMCs it is a
 * redemption plus a purchase, which BSE refuses. Only a fact BSE actually published refuses
 * here: an AMC or a Switch-IN/OUT row it never sent is left to BSE, exactly like the other
 * order checks. A missing or closed destination is refused outright — that is the purchase
 * half of the switch, and a purchase into a closed scheme is refused the same way.
 */
const amcKey = (s, key) => String(s?.[key] || "").trim().toUpperCase();
function switchRefusal(source, dest) {
  if (!dest || !isTransactable(dest)) return "The destination scheme is not open for investment.";
  // Compare like with like: a code against a code, a name against a name.
  for (const key of ["amc_code", "scheme_amc_name", "amc_name"]) {
    const a = amcKey(source, key);
    const b = amcKey(dest, key);
    if (a && b) {
      if (a !== b) return "A switch can only move money between schemes of the same fund house (AMC).";
      break;
    }
  }
  if (schemeTransactions(source || {}).switchOut?.allowed === false) {
    return "This scheme does not allow switching out. Redeem instead.";
  }
  if (schemeTransactions(dest).switchIn?.allowed === false) {
    return "The destination scheme does not accept switches in.";
  }
  return null;
}

/**
 * Audit #42 — money leaves only for an investor whose PAN is verified.
 *
 * `pan_verified` is the flag Laravel sets when BSE approves the UCC (KycController::syncBseKyc)
 * or the PAN provider confirms the number, and that an approved PAN change clears on purpose
 * ("re-verify it to restore full withdrawal access"). investor-data carries it on `profile`.
 */
const panVerified = (investor) => [true, 1, "1", "true"].includes(investor?.profile?.pan_verified);
const PAN_NOT_VERIFIED =
  "Withdrawals need a verified PAN, and yours is not verified yet. Open KYC to verify it, then try again.";

/** The PANs on a get_ucc record — what the 2FA and cancel payloads both carry. */
const holderPans = (info) =>
  (info?.holder || [])
    .map(
      (h) =>
        (h?.identifier || []).find((i) => String(i?.identifier_type || "").toLowerCase() === "pan")
          ?.identifier_number
    )
    .filter(Boolean);

/**
 * Audit #49 — BSE's order_cancel, in exactly the shape of orderRequestData.cancelPurchaseOrder.
 * The UCC is the session's and the holder block is BSE's own get_ucc record, never the
 * browser's. With no record the template's own empty values go, as the template shows them.
 */
function buildCancelOrderPayload(id, { ucc, info, remark } = {}) {
  const n = Number(id);
  return {
    data: {
      id: Number.isFinite(n) ? n : String(id),
      investor: { ucc, pan_holders: holderPans(info), holding_nature: info?.holding_nature || "" },
      remark: String(remark || "").trim().slice(0, 200) || "Cancelled by investor",
    },
  };
}

// 2FA link ki request mein asli UCC jana chahiye. fetch2FALinkRequestData sirf sample
// hai — usay jaisa ka waisa bhejne se BSE kisi aur (mojood hi nahi) client ka link banata
// hai. PAN aur holding_nature get_ucc ke record se aate hain.
function twoFaUccPayload(event, { ucc, info, memberCode }) {
  const pans = holderPans(info);
  return {
    data: [
      {
        event,
        investor: {
          client_code: ucc,
          pan_holder: pans.length ? pans : [""],
          holding_nature: info?.holding_nature || "",
        },
        parent_client_code: "",
        member_code: memberCode,
      },
    ],
  };
}

function normalizeOrder(order, { ucc, memberCode, mobile, euin = "" }) {
  const type = String(order.type || "").toLowerCase();
  const allUnits = !!order.all_units;
  const mobnum = mobile || normalizeMobile(order.mobnum);
  const holder = Array.isArray(order.holder)
    ? order.holder.map((h) => ({ ...h, mobnum: normalizeMobile(h?.mobnum) || mobnum }))
    : order.holder;
  // ponytail: BSE uppercase "P"/"D" leta hai — orderRequestData.purchaseNewOrder dekho.
  // Demat par depository_acct {depository, dp_id, client_id} lazmi hai (msgid 1522),
  // wo details kahin store nahi hotin; DP data aate hi ye khud "D" par chala jayega.
  const dp = order.depository_acct;
  const hasDp = !!(dp && String(dp.dp_id || "").trim() && String(dp.client_id || "").trim());
  return {
    ...order,
    type,
    amount: allUnits ? 0 : Number(order.amount || 0),
    investor: { ...(order.investor || {}), ucc },
    member: memberCode,
    mem_ord_ref_id: String(order.mem_ord_ref_id || Date.now()),
    cur: order.cur || "INR",
    mobnum,
    holder,
    phys_or_demat: hasDp ? "D" : "P",
    depository_acct: hasDp ? dp : {},
    // AMFI: every order carries the distributor block and the execution-only declaration.
    // Built AFTER the caller's fields are spread, so a browser-supplied `mem_details` can
    // never overwrite it — which is exactly how a fabricated EUIN used to reach the exchange.
    //
    // No EUIN is read from the order ON PURPOSE. An EUIN attributes the trade to a named
    // employee and earns them the commission; if the browser could name one, anybody could
    // attribute anybody's order. Audit #33 — `euin` is the caller's, and the only caller
    // that sets it passes what the disclaimer gate resolved against the admin's RM register
    // (req.rmEuin). Blank, which is every other order, means execution-only.
    // Sent verbatim as AMFI writes it: EUIN empty, declaration set. Probed live against
    // order_new on 2026-09-24 — the full block, an empty euin, and a named euin are all
    // accepted, so nothing has to be trimmed here the way sxp_register forced.
    //
    // Note from that probe: BSE accepted the ILLEGAL pair (named euin + declaration) without
    // complaint. The exchange will not catch it, so assertEuinSane is the only thing that does.
    mem_details: memDetails({ euin, omitEmpty: false }),
  };
}

module.exports = {
  normalizeMobile,
  BSE_PLACEHOLDER_MOBILE,
  investorMobile,
  investorUcc,
  requestedUcc,
  uccMatches,
  bindUcc,
  validateOrder,
  checkSchemeLimits,
  allowedModes,
  twoFaUccPayload,
  normalizeOrder,
  switchRefusal,
  panVerified,
  PAN_NOT_VERIFIED,
  buildCancelOrderPayload,
};
