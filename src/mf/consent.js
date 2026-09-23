const axios = require("axios");
const { configData } = require("../config");

/**
 * §2 "Digital Consent Matrix" + §4.1 — writing the consent audit trail.
 *
 * ── Why Node records this and not the browser ────────────────────────────────────────────
 * The consent that matters is the one attached to the order that was actually placed. The
 * browser can tell you what it rendered; only this path knows what got through the gate and
 * reached BSE. Recording from here means a consent row exists if and only if an order was
 * accepted, and the two carry the same reference.
 *
 * ── Why it never blocks ──────────────────────────────────────────────────────────────────
 * The disclaimer GATE already refused the order if the ticks were missing — by the time this
 * runs, the investor has consented and the order is going to the exchange. Failing the trade
 * because the log write timed out would punish the investor for our bookkeeping, and would
 * leave money in limbo at BSE with nothing recorded either way. So a failure is loud in the
 * logs and returns false; it does not throw and it does not stop the order.
 *
 * That trade-off is only acceptable because the gate is the control and this is the record.
 * If this were the control, it would have to fail closed.
 */

const url = () => `${String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "")}/consents`;

/**
 * @param req     the express request, for the investor's own bearer and their real IP
 * @param entries [{ type, order_id?, scheme_codes?, euin_number?, euin_declared?, ... }]
 * @returns {Promise<boolean>} whether the trail was written
 */
async function recordConsents(req, entries = []) {
  const consents = (Array.isArray(entries) ? entries : []).filter((e) => e && e.type);
  if (!consents.length) return false;

  const authorization = req.headers?.authorization;
  if (!authorization) {
    console.warn("[consent] no bearer to record against — consent NOT logged");
    return false;
  }

  try {
    await axios.post(
      url(),
      { consents, device_id: req.headers?.["x-device-id"] || null },
      {
        timeout: 10000,
        headers: {
          authorization,
          // Laravel binds the investor JWT to the caller's User-Agent; a different one (or
          // none) answers 401 — the same trap the approval check documents.
          "user-agent": req.headers?.["user-agent"] || "",
          // The audit row must carry the INVESTOR's address, not this box's. Node is a
          // middlebox here, so without this every row would record the same EC2 address.
          "x-forwarded-for": req.headers?.["x-forwarded-for"] || req.ip || "",
          accept: "application/json",
        },
      },
    );
    return true;
  } catch (err) {
    // Loud, because a missing consent row is an audit finding even though the order is fine.
    console.error(
      "[consent] FAILED to record consent trail:",
      err.response ? `${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message,
    );
    return false;
  }
}

module.exports = { recordConsents };
