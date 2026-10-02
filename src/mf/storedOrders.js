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

/**
 * Audit #48/#49 — BSE's word for an order, in our state model:
 *   pending → completed | rejected | cancelled
 * null means the order can still move (PENDING, ACCEPTED, PAID…), so there is nothing final to
 * record and nobody to tell. Cancel is read first: "CANCELLED" also contains no ALLOT, but a
 * status such as "ALLOTMENT CANCELLED" must not read as allotted.
 */
function orderState(bseStatus) {
  const s = String(bseStatus || "").toUpperCase();
  if (/CANCEL/.test(s)) return "cancelled";
  if (/REJECT|FAIL/.test(s)) return "rejected";
  if (/ALLOT|COMPLET|PROCESSED|SETTLED/.test(s)) return "completed";
  return null;
}

/**
 * Stored orders (Laravel) whose BSE status has reached a final state they do not record yet.
 * Matched on BSE's order id only — a composite key could pin one order's news on another.
 */
function statusChanges(stored = [], live = []) {
  const byId = new Map(live.filter((o) => o?.id != null).map((o) => [String(o.id), o]));
  const out = [];
  for (const row of stored) {
    if (row?.id == null) continue;
    const hit = byId.get(String(row.id));
    const state = orderState(hit?.status);
    if (!state || state === String(row.status || "").toLowerCase()) continue;
    out.push({
      bse_order_id: Number(row.id),
      state,
      bse_status: String(hit.status).slice(0, 40),
      remarks: String(hit.remarks || "").slice(0, 300),
    });
  }
  return out;
}

const laravel = (path) => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, path);
const headersOf = (req) => ({
  authorization: req.headers?.authorization,
  // Laravel binds the investor JWT to the caller's User-Agent; see storedOrders above.
  "user-agent": req.headers?.["user-agent"] || "",
  accept: "application/json",
});

/**
 * Tell Laravel which of the investor's orders BSE has settled. Laravel updates bse_orders and
 * notifies once per transition; a second report of the same state changes nothing there.
 * Never throws: this is bookkeeping riding on a page load, and BSE stays the authority.
 */
async function reportStatusChanges(req, changes = []) {
  if (!changes.length || !req?.headers?.authorization) return false;
  try {
    await axios.post(laravel("/bse/order-status"), { updates: changes }, { timeout: 15000, headers: headersOf(req) });
    return true;
  } catch (err) {
    console.warn("[orders] status sync failed:", err.response?.status || err.message);
    return false;
  }
}

/**
 * Write one placed order to bse_orders — the record the investor-facing pages read. Used where
 * the SERVER placed the order (basket checkout), so the record does not depend on a browser
 * tab staying open after BSE accepted it. Same endpoint the single-fund pages post to.
 */
async function recordOrder(req, row) {
  if (!req?.headers?.authorization) return false;
  try {
    await axios.post(laravel("/bse/order"), row, { timeout: 15000, headers: headersOf(req) });
    return true;
  } catch (err) {
    console.error("[orders] could not record order", row?.bse_order_id, err.response?.status || err.message);
    return false;
  }
}

module.exports = { storedOrders, orderKey, normaliseType, orderState, statusChanges, reportStatusChanges, recordOrder };
