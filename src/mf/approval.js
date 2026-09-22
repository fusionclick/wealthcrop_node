const axios = require("axios");
const { configData } = require("../config");

/**
 * SRS §4 "Transaction States" / "Authorization" — a transaction above a configured amount
 * is held until an admin releases it.
 *
 * ── Why this lives here and not in Laravel ───────────────────────────────────────────────
 * `bse_orders` is written AFTER the order has been placed. Anything that only inspects
 * that table can report on a transaction, never stop one. This runs inside the same gate
 * as the disclaimer and suitability checks — the last point at which "no" still means
 * nothing happened.
 *
 * ── Failure behaviour ────────────────────────────────────────────────────────────────────
 * The threshold is read like riskPolicy reads its ceilings: cached, last-good-value kept
 * when Laravel is unreachable, DEFAULT_THRESHOLD (0 = off) before the first successful
 * read. An install that never configures this is never affected by it.
 *
 * The clearance CHECK is different and deliberately fails CLOSED: if the threshold says a
 * transaction must be authorised and we cannot reach the service that records
 * authorisations, the honest answer is "not right now", not "go ahead". The investor sees
 * a try-again message, and nothing has been placed.
 */

const base = () => String(configData.investorUrl || "").replace(/\/investor-data\/?$/, "");
const policyUrl = () => `${base()}/order-approval-policy`;
const checkUrl = () => `${base()}/order-approvals/check`;

const TTL_MS = 5 * 60 * 1000;
const DEFAULT_THRESHOLD = 0; // off

let cache = { at: 0, threshold: DEFAULT_THRESHOLD };
let inFlight = null;

/** A negative or unparseable threshold is a typo, not a stricter rule. */
const clean = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
};

async function loadThreshold() {
  const res = await axios.get(policyUrl(), { timeout: 8000 });
  return { at: Date.now(), threshold: clean(res?.data?.data?.threshold) };
}

async function getThreshold() {
  if (Date.now() - cache.at < TTL_MS) return cache.threshold;
  if (!inFlight) {
    inFlight = loadThreshold()
      .then((fresh) => {
        cache = fresh;
        return cache.threshold;
      })
      .catch((err) => {
        console.warn("[mf] approval policy unavailable, keeping current:", err.message);
        cache = { ...cache, at: Date.now() };
        return cache.threshold;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * May this transaction go through?
 *
 * @param req       the express request, for the investor's own bearer token
 * @param intent    { kind, scheme_code, scheme_name, amount }
 * @returns null when allowed, or an error body to send with 403
 */
async function checkApproval(req, intent) {
  const amount = Number(intent?.amount) || 0;
  const threshold = await getThreshold();

  // The overwhelmingly common path: the control is off, or the amount is under it. No
  // network call at all, so an install with approvals disabled pays nothing for them.
  if (threshold <= 0 || amount < threshold) return null;

  const authorization = req.headers?.authorization;
  if (!authorization) {
    return {
      status: "error",
      code: "ORDER_APPROVAL_UNAVAILABLE",
      message: "This transaction needs approval and we could not verify your session. Please try again.",
    };
  }

  let decision;
  try {
    const res = await axios.post(
      checkUrl(),
      {
        kind: intent.kind,
        scheme_code: intent.scheme_code,
        scheme_name: intent.scheme_name || "",
        amount,
      },
      {
        timeout: 10000,
        headers: {
          authorization,
          // Laravel binds the investor JWT to the caller's User-Agent; forwarding a
          // different one (or none) makes every call here answer 401.
          "user-agent": req.headers?.["user-agent"] || "",
          accept: "application/json",
        },
      }
    );
    decision = res?.data;
  } catch (err) {
    // Fails closed, on purpose. See the header comment.
    console.warn("[mf] approval check failed:", err.message);
    return {
      status: "error",
      code: "ORDER_APPROVAL_UNAVAILABLE",
      message: "This transaction needs approval and the approval service is not responding. Nothing has been placed — please try again shortly.",
    };
  }

  if (decision?.decision === "allow") return null;

  if (decision?.decision === "rejected") {
    return {
      status: "error",
      code: "ORDER_APPROVAL_REJECTED",
      message: decision.message || "This transaction was not approved.",
    };
  }

  return {
    status: "error",
    code: "ORDER_APPROVAL_REQUIRED",
    message:
      decision?.message ||
      "This transaction is above the amount we can process without a second check. It has been sent for approval.",
    approval: decision?.approval || null,
  };
}

/** Synchronous read of whatever threshold is cached — never triggers a fetch. */
const peekThreshold = () => cache.threshold;

module.exports = { checkApproval, getThreshold, peekThreshold, DEFAULT_THRESHOLD };
