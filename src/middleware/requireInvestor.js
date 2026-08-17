const axios = require("axios");
const { configData } = require("../config");
const { uccMatches } = require("../mf/order");

async function requireInvestor(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ") || auth.length < 16) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }
  try {
    const r = await axios.get(configData.investorUrl, {
      headers: { Authorization: auth, Accept: "application/json" },
      timeout: 10000,
    });
    const investor = r.data?.data;
    if (!investor || r.data?.status === false) {
      return res.status(401).json({ status: "error", message: "Unauthorized" });
    }
    req.investor = investor;
    return next();
  } catch (_) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
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
