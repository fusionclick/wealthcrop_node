require("dotenv").config();

const demoUrl = "https://starmfv2demo.bseindia.com";

function resolveBseBaseUrl(rawInput = process.env.BSE_BASE_URL) {
  const raw = String(rawInput || demoUrl).replace(/\/$/, "");
  try {
    const host = new URL(raw).hostname.toLowerCase();
    // starmfv2.bseindia.com is a placeholder — public DNS does not resolve it
    if (!host || host === "starmfv2.bseindia.com") return demoUrl;
    return raw;
  } catch {
    return demoUrl;
  }
}

const baseUrl = resolveBseBaseUrl();

if (baseUrl.includes("starmfv2demo") || process.env.BSE_TLS_INSECURE === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const https = require("https");
  const axios = require("axios");
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
}

const PROD_INVESTOR = "https://admin.wealthcrop.co/api/internal/investor-data";

function resolveInvestorUrl(
  explicit = process.env.LARAVEL_INVESTOR_URL,
  webhook = process.env.LARAVEL_WEBHOOK_URL || ""
) {
  const isLocal = (u) => /localhost|127\.0\.0\.1/i.test(u);
  // ponytail: EC2 par copy ki hui local .env Node ko 127.0.0.1:8000 par bhejti hai —
  // connect instantly refuse hota hai aur har request 401 ban jaati hai. Production mein
  // localhost kabhi valid nahi; dev/test mein hai (order.e2e.test.js local stub use karta hai).
  const dead = process.env.NODE_ENV === "production" && isLocal(String(explicit || ""));
  if (explicit && !dead) return explicit;
  const derived = webhook.replace(/\/bse\/payment-callback\/?$/, "/investor-data");
  if (derived && derived !== webhook && !isLocal(derived)) return derived;
  return PROD_INVESTOR;
}

exports.resolveBseBaseUrl = resolveBseBaseUrl;
exports.resolveInvestorUrl = resolveInvestorUrl;
exports.configData = {
  username: process.env.BSE_USERNAME || "",
  password: process.env.BSE_PASSWORD || "",
  baseUrl,
  memberCode: process.env.BSE_MEMBER_CODE || "91010",
  investorUrl: resolveInvestorUrl(),
};
