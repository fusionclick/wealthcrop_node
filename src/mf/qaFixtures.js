/**
 * A BSE-shaped order/registration book for designated QA client codes.
 *
 * Why this exists
 * ---------------
 * Order history, XIRR, the folio list behind Redeem/Switch, and the SIP cards all read
 * live BSE — `order_list` (getAllOrders) and `sxp_list` (getAllXsp). None of them read
 * the Laravel `bse_orders` table, which is only the admin panel's mirror. So seeding that
 * table can never put a folio on a holding or a row in Order History, and BSE itself will
 * not produce either until the UCC is approved on their side, which is not ours to do.
 *
 * That left seven acceptance tickets (14, 15, 17, 18, 19, 20, 21) untestable for reasons
 * no code change to the seeder could fix. This answers the two BSE calls they depend on
 * with a deterministic book instead, for client codes that are explicitly listed in
 * MF_QA_UCC and no others.
 *
 * Safety: with MF_QA_UCC unset — which is every environment that is not the QA one —
 * `answer()` returns null on the first line and nothing downstream changes at all. The
 * allowlist is exact client codes, not a prefix or a pattern, so a real investor cannot
 * fall into it by having a similar-looking UCC.
 *
 * The book lives in memory and reseeds on restart. That is deliberate: QA wants a known
 * starting point each round, and a cancelled SIP coming back after a deploy is easier to
 * explain than a fixture that has drifted.
 */

const uccList = () =>
  String(process.env.MF_QA_UCC || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

const enabled = () => uccList().length > 0;

/** ISO date N months back from today, so cash flows always span a real interval. */
const monthsAgo = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
};

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const SCHEMES = {
  equity: {
    scheme: "PP001ZG-GR",
    scheme_isin: "INF879O01027",
    src_scheme_name: "PARAG PARIKH FLEXI CAP FUND - DIRECT PLAN GROWTH",
    scheme_category: "Equity",
    folio_num: "QA1000001",
  },
  debt: {
    scheme: "HDLFDDN-DR",
    // No ISIN on purpose. The one guessed here resolved to a neighbouring plan whose real
    // NAV is ~24x this fixture's, and the portfolio reported +2350% on it. Without an ISIN
    // the scheme simply is not priced, which is the honest half of the pair: one holding
    // that values and one that cannot, so QA sees both paths.
    scheme_isin: "",
    src_scheme_name: "HDFC LIQUID FUND - DIRECT PLAN - GROWTH",
    scheme_category: "Debt",
    folio_num: "QA1000002",
  },
};

const order = (ucc, id, scheme, { months, days, amount, nav, type = "P", status = "ALLOTTED", remarks = "" }) => ({
  ...scheme,
  id,
  order_id: id,
  ucc,
  client_code: ucc,
  order_date: days != null ? daysAgo(days) : monthsAgo(months),
  trxn_type: type,
  amount,
  nav,
  // Rejected orders never allotted anything; a unit count on them would inflate the
  // portfolio and quietly corrupt XIRR.
  units: status === "REJECTED" ? 0 : Number((amount / nav).toFixed(3)),
  status,
  remarks,
});

const sxp = (ucc, reg_no, scheme, extra) => ({
  ...scheme,
  reg_no,
  ucc,
  client_code: ucc,
  src_scheme: scheme.scheme,
  status: "ACTIVE",
  mandate_status: "APPROVED",
  freq: "m",
  txn_date: 10,
  // Real sxp_list carries the registered instalment count, and a modify re-registers with
  // it. Leaving it out here made the fixture easier to satisfy than production.
  ninstallments: 120,
  ...extra,
});

/**
 * Four purchases a year apart on the equity fund, two on the debt one, plus a redemption
 * and a rejection. The rejection is there on purpose: history has to show a failed order,
 * and holdings have to not show it.
 */
function seed(ucc) {
  const e = SCHEMES.equity;
  const d = SCHEMES.debt;
  return {
    orders: [
      order(ucc, 900001, e, { months: 11, amount: 5000, nav: 62.4 }),
      order(ucc, 900002, e, { months: 8, amount: 6000, nav: 65.1 }),
      order(ucc, 900003, e, { months: 5, amount: 7000, nav: 69.8 }),
      order(ucc, 900004, e, { months: 2, amount: 8000, nav: 74.2 }),
      order(ucc, 900005, d, { months: 9, amount: 10000, nav: 48.6 }),
      order(ucc, 900006, d, { months: 3, amount: 12000, nav: 50.1 }),
      order(ucc, 900007, d, { months: 1, amount: 4000, nav: 50.9, type: "R" }),
      order(ucc, 900008, e, {
        days: 15,
        amount: 3000,
        nav: 75.0,
        status: "REJECTED",
        remarks: "Payment not received within cut-off",
      }),
    ],
    sxp: [
      sxp(ucc, "QASIP0001", SCHEMES.equity, {
        sxp_type: "SIP",
        amount: 5000,
        start_date: monthsAgo(11),
        next_due_date: monthsAgo(-1),
        total_amt_paid: 26000,
        current_value: 29450,
      }),
      sxp(ucc, "QASWP0001", SCHEMES.debt, {
        sxp_type: "SWP",
        amount: 2000,
        start_date: monthsAgo(6),
        next_due_date: monthsAgo(-1),
        total_amt_paid: 12000,
        current_value: 0,
      }),
      sxp(ucc, "QASTP0001", SCHEMES.debt, {
        sxp_type: "STP-OUT",
        amount: 3000,
        start_date: monthsAgo(4),
        next_due_date: monthsAgo(-1),
        total_amt_paid: 12000,
        current_value: 0,
      }),
    ],
  };
}

const books = new Map();

function book(ucc) {
  const key = String(ucc || "").toUpperCase();
  if (!key || !uccList().includes(key)) return null;
  if (!books.has(key)) books.set(key, seed(key));
  return books.get(key);
}

/**
 * Which QA book, if any, this request belongs to.
 *
 * The client code sits in a different place in every payload BSE accepts — `filter_param.ucc`
 * for order_list, `search.value` for sxp_list, `investor.ucc` for an order — and the cancel
 * and pause calls carry only a registration number. Rather than track all of those, scan the
 * serialised payload for a listed code, then fall back to whichever book owns the reg_no.
 * The allowlist is exact codes, so a scan cannot match anything it should not.
 */
function bookFor(reqObj) {
  if (!enabled()) return null;
  const blob = JSON.stringify(reqObj || {}).toUpperCase();
  const hit = uccList().find((u) => blob.includes(u));
  if (hit) return [hit, book(hit)];

  // A registration or order id on its own — cancel/pause carry no client code, and neither
  // does the order-detail lookup behind a history row.
  const reg = blob.match(/QA(?:SIP|SWP|STP)\d+/)?.[0] || null;
  const id = Number(reqObj?.data?.id ?? reqObj?.data?.order_id);
  if (!reg && !Number.isFinite(id)) return null;

  for (const ucc of uccList()) {
    const b = book(ucc);
    if (reg && b?.sxp.some((s) => s.reg_no === reg)) return [ucc, b];
    if (Number.isFinite(id) && b?.orders.some((o) => o.id === id)) return [ucc, b];
  }
  return null;
}

const ok = (lists) => ({ status: "success", data: { lists, count: lists.length, total_count: lists.length } });

/**
 * A canned BSE reply for a QA client code, or null to let the real call through.
 *
 * Returning null rather than throwing matters: a service method this does not know about,
 * or any request from a UCC that is not listed, has to reach BSE untouched.
 */
function answer(serviceMethod, reqObj) {
  const found = bookFor(reqObj);
  if (!found) return null;
  const [ucc, b] = found;
  const blob = JSON.stringify(reqObj || {}).toUpperCase();
  const regNo = blob.match(/QA(?:SIP|SWP|STP)\d+/)?.[0] || null;
  const find = () => b.sxp.find((s) => s.reg_no === regNo);

  switch (serviceMethod) {
    case "getAllOrders":
      return ok(b.orders);

    case "getAllXsp":
      return ok(b.sxp);

    case "getXsp":
      return find() ? ok([find()]) : ok([]);

    // An order id from this book does not exist at BSE, so the detail lookup behind a
    // history row was answering `record_not_found` on every poll. The ids are ours; the
    // answer has to be ours too.
    case "getOrder": {
      const id = Number(reqObj?.data?.id ?? reqObj?.data?.order_id);
      const row = b.orders.find((o) => o.id === id);
      return row ? { status: "success", data: row } : null;
    }

    // Ticket 20. The caller has already refused an order that is not active, so reaching
    // here means the change is allowed.
    case "cancelXsp": {
      const row = find();
      if (!row) return null;
      row.status = "CANCELLED";
      return { status: "success", message: "Registration cancelled.", data: { reg_no: row.reg_no } };
    }

    case "pauseXsp": {
      const row = find();
      if (!row) return null;
      row.status = "PAUSED";
      return { status: "success", message: "Registration paused.", data: { reg_no: row.reg_no } };
    }

    case "resumeXsp": {
      const row = find();
      if (!row) return null;
      row.status = "ACTIVE";
      return { status: "success", message: "Registration resumed.", data: { reg_no: row.reg_no } };
    }

    // Ticket 19 — Top-Up. The limit check runs before this against the real scheme master,
    // so by here the amount is already known to be acceptable.
    case "topupXsp": {
      const row = find();
      if (!row) return null;
      row.topup_amount = Number(String(reqObj?.data?.topup_amount || reqObj?.data?.amount || 0));
      return { status: "success", message: "Top-up registered.", data: { reg_no: row.reg_no } };
    }

    // Tickets 17, 18, 21 — a new SWP/STP, and the re-registration half of a SIP modify.
    case "xspRegister": {
      const d = reqObj?.data || {};
      const type = String(d.sxp_type || "SIP").toUpperCase();
      const prefix = type.startsWith("SWP") ? "QASWP" : type.startsWith("STP") ? "QASTP" : "QASIP";
      const reg = `${prefix}${String(1000 + b.sxp.length)}`;
      const scheme =
        Object.values(SCHEMES).find((s) => s.scheme === String(d.src_scheme || d.scheme || "")) || SCHEMES.equity;
      b.sxp.push(
        sxp(ucc, reg, scheme, {
          sxp_type: type,
          amount: Number(d.amount || d.installment_amount || 0),
          start_date: d.start_date || daysAgo(0),
          next_due_date: d.start_date || daysAgo(0),
          total_amt_paid: 0,
          current_value: 0,
          freq: d.freq || "m",
          txn_date: d.txn_date || 10,
        })
      );
      return { status: "success", message: "Registration created.", data: { reg_no: reg, lists: [{ reg_no: reg }] } };
    }

    // Redeem and Switch both land here. Recorded so the order shows up in history on the
    // next load rather than vanishing into a success toast.
    case "purchaseNewOrder": {
      const o = reqObj?.data?.orders?.[0] || {};
      const scheme = Object.values(SCHEMES).find((s) => s.scheme === String(o.scheme || "")) || SCHEMES.equity;
      const id = 910000 + b.orders.length;
      b.orders.unshift(
        order(ucc, id, scheme, {
          days: 0,
          amount: Number(o.amount || 0) || 1000,
          nav: 75.0,
          type: String(o.type || "P").toUpperCase() === "R" ? "R" : "P",
          status: "ACCEPTED",
        })
      );
      return {
        status: "success",
        data: { items: [{ id, mem_ord_ref_id: o.mem_ord_ref_id || String(id) }] },
      };
    }

    default:
      return null;
  }
}

/** Test seam — drop the in-memory books so a case starts from the seeded state. */
function reset() {
  books.clear();
}

module.exports = { answer, reset, enabled };
