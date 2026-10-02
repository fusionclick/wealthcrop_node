const axios = require("axios");
const { configData } = require("../config");

/**
 * §2 "Digital Consent Matrix" + §4.1 — writing the consent audit trail.
 *
 * Node saves the investor's declaration BEFORE submitting an instruction to BSE.
 * False means the caller must stop. A consent records an authorised attempt; the separate
 * order/mandate record describes whether the exchange subsequently accepted that attempt.
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
    const response = await axios.post(
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
    return response.data?.status === true;
  } catch (err) {
    // The caller refuses submission rather than losing the audit trail.
    console.error(
      "[consent] FAILED to record consent trail:",
      err.response ? `${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message,
    );
    return false;
  }
}

module.exports = { recordConsents };
