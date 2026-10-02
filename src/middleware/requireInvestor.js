const axios = require("axios");
const { configData } = require("../config");
const { uccMatches } = require("../mf/order");
const { isBseDemo } = require("../config");

// Production requests must never submit money/account changes to the UAT exchange.
function requireLiveBse(req, res, next) {
  if (process.env.NODE_ENV !== "production") return next();
  if (isBseDemo(configData.baseUrl)) {
    return res.status(503).json({ status: "error", code: "BSE_LIVE_UNAVAILABLE", message: "Live BSE access is not configured. No exchange action was submitted." });
  }
  if (req.path === "/v2/add_ucc") {
    // The current template invents FATCA/occupation declarations that this form never captures.
    return res.status(503).json({ status: "error", code: "LIVE_ONBOARDING_UNAVAILABLE", message: "Live onboarding requires verified investor declarations before submission." });
  }
  return next();
}

async function requireInvestor(req, res, next) {
  const auth = String(
    req.headers.authorization || req.headers.Authorization || req.headers["x-authorization"] || ""
  ).trim();
  if (!auth.startsWith("Bearer ") || auth.length < 16) {
    return res.status(401).json({ status: "error", message: "Unauthorized", reason: "no_bearer_token" });
  }
  try {
    const userAgent = String(req.headers["user-agent"] || "").trim();
    const r = await axios.get(configData.investorUrl, {
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      timeout: 10000,
    });
    const investor = r.data?.data;
    if (!investor || r.data?.status === false) {
      console.error("[auth] rejected by", configData.investorUrl, r.status, r.data?.message);
      return res.status(401).json({ status: "error", message: "Unauthorized", reason: "token_rejected" });
    }
    req.investor = investor;
    return next();
  } catch (e) {
    // ponytail: 401 pehle har wajah ke liye ek jaisa tha — ab reason batata hai
    const reason = e.response ? "token_rejected" : "upstream_unreachable";
    console.error(
      "[auth]", reason, configData.investorUrl,
      e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.code || e.message
    );
    return res.status(401).json({ status: "error", message: "Unauthorized", reason });
  }
}

function requireMatchingUcc(req, res, next) {
  const check = uccMatches(req.investor, req.body || {});
  if (!check.ok) {
    return res.status(403).json({ status: "error", message: check.error });
  }
  req.ucc = check.ucc;
  return next();
}

module.exports = { requireInvestor, requireMatchingUcc, requireLiveBse };
