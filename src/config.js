require("dotenv").config();

const demoUrl = "https://starmfv2demo.bseindia.com";
const webhook = process.env.LARAVEL_WEBHOOK_URL || "";
const investorFromWebhook = webhook
  ? webhook.replace(/\/bse\/payment-callback\/?$/, "/investor-data")
  : "";

exports.configData = {
  username: process.env.BSE_USERNAME || "",
  password: process.env.BSE_PASSWORD || "",
  baseUrl: (process.env.BSE_BASE_URL || demoUrl).replace(/\/$/, ""),
  memberCode: process.env.BSE_MEMBER_CODE || "91010",
  investorUrl:
    process.env.LARAVEL_INVESTOR_URL ||
    investorFromWebhook ||
    "https://admin.wealthcrop.co/api/internal/investor-data",
};
