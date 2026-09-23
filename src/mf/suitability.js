// Risk-based order gating (ticket 24) and the statutory disclaimer gate (ticket 22).
//
// Both rules existed only in the browser. `isFundSuitable` and `validateInvestorReady` live
// in Frontend/src/utils/nodeApi.js and are real checks — but they are checks a curl command
// never runs. Every one of /purchaseNewOrder, /xspRegister and /modifyXsp would happily
// place an order for an investor with no risk profile at all, into a fund their profile
// rules out, with no disclaimer ever shown. "Direct API requests must not be able to bypass
// risk restrictions" is exactly that hole, and this module is the server-side half.
//
// The browser keeps its copy: it is what makes the UI explain itself before the investor
// gets as far as pressing Invest. This one is the authority.

const { normaliseRisk, RISK_LEVELS } = require("./kuvera");
const { peekRiskPolicy } = require("./riskPolicy");

const RISK_RANK = new Map(RISK_LEVELS.map((r, i) => [r, i + 1]));

/**
 * The highest SEBI riskometer level each investor profile may buy into.
 *
 * SEBI's six levels, not the three the browser collapsed them to: a "Moderately High" fund
 * and a "Very High" one are not the same proposition for a moderate investor, and the old
 * three-bucket mapping said they were.
 *
 * ponytail: a plain table. These are business rules that change by memo, not by algorithm,
 * and RISK_POLICY is the one place to change them.
 */
const RISK_POLICY = {
  conservative: 3, // up to Moderate
  moderate: 4, // up to Moderately High
  aggressive: 6, // up to Very High
};

/** Laravel stores the label on UserRiskProfile.profile; spellings vary by questionnaire version. */
function investorProfileOf(investor = {}) {
  const rp = investor.riskProfile || investor.risk_profile || {};
  const raw = String(rp.profile || rp.category || rp.risk_category || "").toLowerCase();
  if (!raw) return null;
  if (/conserv|low|cautious/.test(raw)) return "conservative";
  if (/aggress|high|growth/.test(raw)) return "aggressive";
  if (/moderate|balanced|medium/.test(raw)) return "moderate";
  return null;
}

/**
 * Categories SEBI's riskometer alone does not capture well enough to gate on.
 *
 * A sectoral or thematic fund is concentrated by construction, and a small cap fund can
 * carry a "High" label that understates what a conservative investor is taking on. These
 * are the same overrides the browser applies, kept so the two agree.
 */
const AGGRESSIVE_ONLY = /small\s*cap|sector|thematic/i;
const GROWTH_AT_LEAST = /mid\s*cap|elss/i;
const ALWAYS_SUITABLE = /debt|liquid|overnight|money\s*market|gilt/i;

/**
 * @param investor  req.investor, as Laravel returned it
 * @param scheme    the mapped scheme row (risk, category, subType)
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 *
 * Fail-closed on the investor, fail-open on the scheme. A missing profile is a hard block —
 * regulation requires one before the order, and the investor can fix it in a minute. A
 * missing SEBI risk level is not: the enrichment source is rate-limited and fail-open, so
 * blocking on it would stop honest orders for a reason the investor cannot act on. Where
 * the level is unknown the category overrides still apply, and if those say nothing either
 * then nothing here can show the fund to be unsuitable, so it goes through.
 */
function checkSuitability(investor, scheme = {}, policy = null) {
  const profile = investorProfileOf(investor);
  if (!profile) {
    return {
      ok: false,
      code: "risk_profile_missing",
      message: "Complete your risk profile before investing. It takes a minute and is required before any order.",
    };
  }
  // Ticket 23 — the ceilings are admin-configurable (see riskPolicy.js). A caller that does
  // not pass one gets whatever is cached, which is the built-in table until Laravel answers.
  const ceiling = (policy || peekRiskPolicy())[profile] ?? RISK_POLICY[profile];
  const category = `${scheme.category || ""} ${scheme.subType || ""} ${scheme.scheme_category || ""}`;

  if (ALWAYS_SUITABLE.test(category)) return { ok: true };

  if (AGGRESSIVE_ONLY.test(category) && profile !== "aggressive") {
    return {
      ok: false,
      code: "risk_category_unsuitable",
      message: `This is a concentrated fund, which does not match your ${profile} risk profile. Choose a diversified fund, or update your risk profile.`,
    };
  }
  if (GROWTH_AT_LEAST.test(category) && profile === "conservative") {
    return {
      ok: false,
      code: "risk_category_unsuitable",
      message: "This fund does not match your conservative risk profile. Choose a lower-risk fund, or update your risk profile.",
    };
  }

  const rank = RISK_RANK.get(normaliseRisk(scheme.risk)) || null;
  if (rank && rank > ceiling) {
    return {
      ok: false,
      code: "risk_level_unsuitable",
      message: `This fund is rated ${normaliseRisk(scheme.risk)} risk, above what your ${profile} risk profile allows. Choose a lower-risk fund, or update your risk profile.`,
    };
  }
  return { ok: true };
}

/**
 * Ticket 22 — statutory and regulatory disclaimers.
 *
 * SEBI's standard warning plus the ones this product's flows require. Configurable by env
 * so legal can change the wording without a deploy of this file; the KEYS are not
 * configurable, because the acknowledgement gate below checks against them.
 *
 * ponytail: a constant with an env override, not a table. The text changes once a year at
 * most and nothing queries it.
 */
/**
 * The distributor's own identity, as AMFI requires it to appear. Every one of these is an
 * env value rather than a literal: a wrong ARN on a screen is a misrepresentation, and the
 * ARN that used to be hardcoded in this codebase belonged to somebody else.
 */
const LEGAL_ENTITY = process.env.LEGAL_ENTITY_NAME || "Wealthcrop Advisory Pvt Ltd";
const DISTRIBUTOR_ARN = String(process.env.DISTRIBUTOR_ARN || "").trim();

const DISCLAIMERS = {
  market_risk:
    process.env.DISCLAIMER_MARKET_RISK ||
    "Mutual fund investments are subject to market risks. Read all scheme related documents carefully.",
  past_performance:
    process.env.DISCLAIMER_PAST_PERFORMANCE ||
    "Past performance is not indicative of future returns. Returns shown are not guaranteed.",
  no_advice:
    process.env.DISCLAIMER_NO_ADVICE ||
    "This platform executes your instructions and does not provide investment advice. Consider your own objectives, or consult a registered adviser.",
  nav_cutoff:
    process.env.DISCLAIMER_NAV_CUTOFF ||
    "Units are allotted at the NAV applicable once funds are realised, which may differ from the NAV shown here.",

  // ── AMFI/SEBI compliance spec §1.B and §2 ────────────────────────────────────────────
  // These three are the consent matrix, not general notices: each one is a statement the
  // investor makes, and each is written to the eight-year consent log with the order id.

  // §2 row 1. AMFI publishes this wording; the placeholder is filled from the legal entity
  // name so a rename cannot leave the declaration naming a company that no longer exists.
  execution_only:
    process.env.DISCLAIMER_EXECUTION_ONLY ||
    `I/We hereby confirm that this is an 'execution-only' transaction executed without any interaction or advice by the employee/sales person of ${LEGAL_ENTITY} or notwithstanding the advice of inappropriateness, if any, provided by ${LEGAL_ENTITY}.`,

  // §1.A.2 + §2 row 3. The commission disclosure is the reason this platform is paid; an
  // investor agreeing to a Regular Plan has to be told that before the money moves.
  regular_plan_commission:
    process.env.DISCLAIMER_REGULAR_PLAN ||
    "All mutual fund transactions offered on this platform are under Regular Plans, which involve the payment of trail commission to us as an AMFI-registered Mutual Fund Distributor.",

  // §2 row 4. The links themselves are per scheme and come from the scheme payload; this is
  // the sentence the tick is against.
  scheme_documents:
    process.env.DISCLAIMER_SCHEME_DOCUMENTS ||
    "I/We confirm that I/We have read and understood the Scheme Information Document (SID), Statement of Additional Information (SAI) and Key Information Memorandum (KIM) of the scheme(s) selected.",

  // §1.B "No Guarantees Warning", in AMFI's own words. `past_performance` above says half of
  // this and is kept because orders already reference it; this is the full statement shown
  // at checkout.
  no_guarantee:
    process.env.DISCLAIMER_NO_GUARANTEE ||
    "Mutual funds do not offer assured or guaranteed returns. Past performance of any scheme or asset class is not indicative of future results.",
};

/**
 * The ones an investor must tick before an order is placed. The rest are shown, not signed.
 *
 * Adding to this list is a breaking change for every checkout screen, which is the point:
 * the server refuses an order whose payload does not carry every key here, so a screen that
 * forgets to render one cannot quietly place orders without it. That is what makes this a
 * gate rather than a notice.
 */
const REQUIRED_ACKS = [
  "market_risk",
  "past_performance",
  // §2 rows 1, 3 and 4 of the consent matrix.
  "execution_only",
  "regular_plan_commission",
  "scheme_documents",
];

/**
 * @returns {{ok: true} | {ok: false, code, message, required: string[]}}
 *
 * The acknowledgement travels with the order rather than being remembered against the
 * account: SEBI's warning is per transaction, and a flag set once at signup would let every
 * later order through unshown — which is the bypass the ticket names.
 */
function checkDisclaimers(input = {}) {
  const raw = input.acknowledged ?? input.disclaimers ?? input.acknowledgements;
  const acked = Array.isArray(raw)
    ? new Set(raw.map(String))
    : raw && typeof raw === "object"
    ? new Set(Object.entries(raw).filter(([, v]) => v === true).map(([k]) => k))
    : new Set();
  const missing = REQUIRED_ACKS.filter((k) => !acked.has(k));
  if (missing.length) {
    return {
      ok: false,
      code: "disclaimer_not_acknowledged",
      message: "Please read and accept the required disclaimers before placing this order.",
      required: missing,
    };
  }
  return { ok: true };
}

module.exports = {
  checkSuitability,
  checkDisclaimers,
  investorProfileOf,
  DISCLAIMERS,
  REQUIRED_ACKS,
  RISK_POLICY,
  LEGAL_ENTITY,
  DISTRIBUTOR_ARN,
};
