//FOR MEMBER LOGIN:
require('dotenv').config();

exports.configData = {
 username: process.env.BSE_USERNAME || "",
 password: process.env.BSE_PASSWORD || "",
 baseUrl: process.env.BSE_BASE_URL || "https://starmfv2demo.bseindia.com",
};


