const axios = require("axios");
const { configData } = require("../config");

/**
 * QA 3.4 — the orders Laravel already holds, in the shape orderHistory returns.
 *
 * `bse_orders` is written the moment an order is accepted; BSE's own `order_list` can take
 * a settlement cycle to show the same order, and on a demo UCC it may never. Reading only
 * BSE meant a just-placed order was missing from /user/mutual_fund/orders while
 * /user/order — which reads Laravel directly — had it. Same investor, same minute, two
 * different answers.
 *
 * ── Failure behaviour: fails OPEN ────────────────────────────────────────────────────────
 * BSE is the authority on what actually happened to an order. If Laravel is unreachable we
 * return nothing extra and the caller still renders BSE's list, exactly as it did before
 * this existed. An order history that errors is worse than one that is a few minutes behind.
 */

const url = () => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "/bse/get-order");

/** BSE's id when there is one; otherwise the same composite orderHistory dedupes on. */
const orderKey = (o) =>
  String(o?.id ?? o?.order_id ?? `${o?.scheme_bse_code || o?.scheme || ""}|${o?.date || o?.order_date || ""}|${o?.amount ?? ""}`);

/** Laravel stores `purchase | redeem | sip`; BSE says `P | R | Purchase | Redemption`. */
const TYPES = { purchase: "Purchase", redeem: "Redemption", redemption: "Redemption", sip: "SIP", switch: "Switch" };
const normaliseType = (v) => TYPES[String(v || "").toLowerCase()] || String(v || "");

async function storedOrders(req) {
  const authorization = req?.headers?.authorization;
  if (!authorization) return [];

  let rows;
  try {
    const res = await axios.get(url(), {
      timeout: 8000,
      headers: {
        authorization,
        // Laravel binds the investor JWT to the caller's User-Agent; forwarding a different
        // one (or none) makes every call here answer 401.
        "user-agent": req.headers?.["user-agent"] || "",
        accept: "application/json",
      },
    });
    rows = res?.data?.data;
  } catch (err) {
    console.warn("[orders] stored orders unavailable:", err.message);
    return [];
  }

  if (!Array.isArray(rows)) return [];

  return rows.map((o) => ({
    id: o.bse_order_id ?? null,
    date: o.created_at || null,
    scheme_name: o.scheme_name || "",
    scheme_bse_code: o.scheme_bse_code || "",
    type: normaliseType(o.order_type),
    amount: Number(o.inv_amo || 0),
    units: 0,
    nav: 0,
    folio: o.folio || "",
    status: o.status || "",
    remarks: "",
    // Tells the UI this row has not been seen in BSE's list yet, so "pending" here means
    // "we have it, BSE has not confirmed" rather than "BSE says pending".
    source: "local",
  }));
}

module.exports = { storedOrders, orderKey, normaliseType };
