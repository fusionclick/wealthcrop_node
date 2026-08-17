const { isTransactable } = require("./scheme");

const ALLOWED_TYPES = new Set(["p", "r"]);

function investorUcc(investor) {
  return String(investor?.kyc?.ucc_code || investor?.kyc?.ucc || "").trim();
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

function normalizeOrder(order, { ucc, memberCode }) {
  const type = String(order.type || "").toLowerCase();
  const allUnits = !!order.all_units;
  return {
    ...order,
    type,
    amount: allUnits ? 0 : Number(order.amount || 0),
    investor: { ...(order.investor || {}), ucc },
    member: memberCode,
    mem_ord_ref_id: String(order.mem_ord_ref_id || Date.now()),
    cur: order.cur || "INR",
  };
}

module.exports = {
  investorUcc,
  requestedUcc,
  uccMatches,
  bindUcc,
  validateOrder,
  checkSchemeLimits,
  normalizeOrder,
};
