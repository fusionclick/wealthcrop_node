const axios = require("axios");
const { configData } = require("../config");
const { uccMatches } = require("../mf/order");

async function requireInvestor(req, res, next) {
  const auth = String(
    req.headers.authorization || req.headers.Authorization || req.headers["x-authorization"] || ""
  ).trim();
  if (!auth.startsWith("Bearer ") || auth.length < 16) {
    return res.status(401).json({ status: "error", message: "Unauthorized", reason: "no_bearer_token" });
  }
  try {
    const r = await axios.get(configData.investorUrl, {
      headers: { Authorization: auth, Accept: "application/json" },
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

module.exports = { requireInvestor, requireMatchingUcc };
