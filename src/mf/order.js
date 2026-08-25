const { isTransactable } = require("./scheme");

const ALLOWED_TYPES = new Set(["p", "r"]);

function investorUcc(investor) {
  const ucc = String(investor?.kyc?.ucc_code || investor?.kyc?.ucc || "").trim();
  if (ucc) return ucc;
  // ponytail: test account — same email as Laravel forgot-PIN bypass
  if (String(investor?.email || "").toLowerCase() === "rminhal783@gmail.com") return "USRWC003";
  return "";
}

// ponytail: BSE sirf 10-digit Indian mobile leta hai — +91, spaces, leading 0 sab reject hote hain.
// Khali string ka matlab "koi valid number nahi"; caller usay 400 bana deta hai.
function normalizeMobile(raw) {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
  const ten = digits.length > 10 && digits.startsWith("91") ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : "";
}

// ponytail: test account — wahi email jiska UCC upar hardcoded hai. Asli fix Laravel
// investor record mein number theek karna hai; ye sirf demo testing chalu rakhta hai.
function investorMobile(investor) {
  const own = normalizeMobile(investor?.phone || investor?.mobile || investor?.mobnum);
  if (own) return own;
  if (String(investor?.email || "").toLowerCase() === "rminhal783@gmail.com") return "8617029131";
  return "";
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
    return { ok: false, error: "Order type must be p (purchase) or r (redeem)" };
  }
  if (!String(order.scheme || "").trim()) {
    return { ok: false, error: "Scheme code is required" };
  }
  const allUnits = !!order.all_units;
  const amount = Number(order.amount || 0);
  if (type === "p" && !(amount > 0)) {
    return { ok: false, error: "Purchase amount must be greater than 0" };
  }
  if (type === "r" && !allUnits && !(amount > 0)) {
    return { ok: false, error: "Enter a redemption amount or redeem all units" };
  }
  if (type === "r" && !String(order.folio || "").trim()) {
    return { ok: false, error: "Folio is required for redemption" };
  }
  return { ok: true, type, order };
}

function checkSchemeLimits(order, scheme) {
  if (!scheme) return { ok: false, error: "Scheme not found or not transactable" };
  const type = String(order.type || "").toLowerCase();
  if (type === "p" && !isTransactable(scheme)) {
    return { ok: false, error: "This scheme is not open for purchase" };
  }
  if (type === "p") {
    const min = Number(scheme.min_lumpsum_amount ?? scheme.min_amt ?? scheme.minLumpsum ?? 0);
    if (min && Number(order.amount) < min) {
      return { ok: false, error: `Minimum investment is ₹${min}` };
    }
  }
  if (type === "r" && !order.all_units) {
    const min = Number(scheme.min_redemption_amount ?? scheme.min_redeem_amt ?? scheme.minRedeem ?? 0);
    if (min && Number(order.amount) < min) {
      return { ok: false, error: `Minimum redemption is ₹${min}` };
    }
  }
  return { ok: true };
}

// BSE har scheme ke liye batata hai ke wo Demat leta hai ya Physical, aur ye
// transaction type ke hisab se alag hota hai — `lumpsum[]` mein Purchase/Redemption/
// Switch ki apni apni entry hoti hai. Kuch schemes (jaise Franklin Pension Plan) sirf
// Physical hain, aur unhein "D" bhejne par BSE msgid 1588 "PhysOrDemat not_allowed" deta hai.
function allowedModes(scheme, txnType = "Purchase") {
  const rows = Array.isArray(scheme?.lumpsum) ? scheme.lumpsum : [];
  const row = rows.find(
    (r) => String(r?.scheme_transaction_type || "").toLowerCase() === txnType.toLowerCase()
  );
  const raw = row?.scheme_transaction_mode_allowed || scheme?.scheme_transaction_mode_allowed;
  if (!Array.isArray(raw) || !raw.length) return null;
  const modes = raw.map((m) => String(m?.scheme_transaction_mode_demat_physical_allowed || "").toLowerCase());
  return { demat: modes.includes("demat"), physical: modes.includes("physical") };
}

// get_ucc ka jawab batata hai ke UCC physical rakh sakta hai ya demat, aur wo mode
// verify hua bhi hai ya nahi. Ye dono BSE order par cryptic errors banti hain —
// phys_or_demat "P" par msgid 1020 phys_ucc, aur verify pending par ucc id_not_exist.
function uccBlocks(info, mode) {
  if (!info) return null;
  const wantPhysical = String(mode).toUpperCase() === "P";
  if (wantPhysical && info.is_client_physical === false) {
    return "This scheme can only be held physically, but your BSE account is registered for demat only. Ask support to register it for physical holdings.";
  }
  if (!wantPhysical && info.is_client_demat === false) {
    return "Your BSE account is not registered for demat holdings.";
  }
  const want = wantPhysical ? "PHYSICAL" : "DEMAT";
  const ready = (Array.isArray(info.transaction_ready) ? info.transaction_ready : []).find(
    (r) => String(r?.mode || "").toUpperCase() === want
  );
  if (ready && String(ready.verified_status).toUpperCase() === "FALSE") {
    const why = String(ready.verification_failed_reason || "").trim();
    return `Your BSE account is not verified for ${want.toLowerCase()} orders yet${why ? ` — ${why}` : ""}.`;
  }
  return null;
}

function normalizeOrder(order, { ucc, memberCode, mobile, modes }) {
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
  // modes null = BSE ne kuch nahi bataya, to purana bartao: DP hai to demat.
  const demat = hasDp && (!modes || modes.demat);
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
    phys_or_demat: demat ? "D" : "P",
    depository_acct: demat ? dp : {},
  };
}

module.exports = {
  normalizeMobile,
  investorMobile,
  investorUcc,
  requestedUcc,
  uccMatches,
  bindUcc,
  validateOrder,
  checkSchemeLimits,
  allowedModes,
  uccBlocks,
  normalizeOrder,
};
