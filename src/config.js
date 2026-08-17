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

const webhook = process.env.LARAVEL_WEBHOOK_URL || "";
const investorFromWebhook = webhook
  ? webhook.replace(/\/bse\/payment-callback\/?$/, "/investor-data")
  : "";

exports.resolveBseBaseUrl = resolveBseBaseUrl;
exports.configData = {
  username: process.env.BSE_USERNAME || "",
  password: process.env.BSE_PASSWORD || "",
  baseUrl,
  memberCode: process.env.BSE_MEMBER_CODE || "91010",
  investorUrl:
    process.env.LARAVEL_INVESTOR_URL ||
    investorFromWebhook ||
    "https://admin.wealthcrop.co/api/internal/investor-data",
};
