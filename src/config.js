//FOR MEMBER LOGIN:
require('dotenv').config();

exports.configData = {
 username: process.env.BSE_USERNAME || "",
 password: process.env.BSE_PASSWORD || "",
 // ponytail: hardcode demo — server .env had dead starmfv2.bseindia.com (NXDOMAIN)
 baseUrl: "https://starmfv2demo.bseindia.com",
};


