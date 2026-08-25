const { configData } = require("../config");
const axios = require("axios");
const https = require("https");
const StarMFService = require("bse-starmfv2-sdk");
const { isTransactable, mapScheme, pickScheme, navLookup, calcReturns, buildChartSeries, fundProfile, ratiosFromSeries, parseListQuery, listCacheKey, getListCache, setListCache } = require("../mf/scheme");
const { loadFundNav } = require("../mf/mfapi");
const { getNavs, navFor, navDateFor } = require("../mf/navStore");
const { getCatalogue, query } = require("../mf/catalogue");
const { bindUcc, validateOrder, checkSchemeLimits, allowedModes, uccBlocks, twoFaUccPayload, normalizeOrder, investorUcc, investorMobile, normalizeMobile } = require("../mf/order");
const orderRequestData = require("../requestData/orderRequestData");
const uccRequestData = require("../requestData/uccRequestData");
const xspRequestData = require("../requestData/xspRequestData");
const nftRequestData = require("../requestData/nftRequestData");
const schemeRequestData = require("../requestData/schemeRequestData");
const paymentRequestData = require("../requestData/paymentRequestData");
const fetch2FALinkRequestData = require("../requestData/fetch2FALinkRequestData");
const mandateRequestData = require("../requestData/mandateRequestData");
const navRequestData = require("../requestData/navRequestData");

// ponytail: BSE galtiyan `messages[]` mein bhejta hai — {msgid, errcode, field, vals}.
// `field` par order ka ref id prefix hota hai ("726215.depository_acct"), wo hata do.
// errcode jaise ka waisa dikhana ("Scheme is record_not_found") user ko kuch nahi batata.
const BSE_ERRCODES = {
  // Har field scheme nahi hoti — get_2fa_link par bhi yehi errcode aata hai.
  record_not_found: "was not found on BSE",
  required: "is required",
  invalid: "is invalid",
  not_allowed: "is not allowed",
};
// Kuch field aise hain jinka errcode bhi kuch nahi batata — inka poora jumla likha hai.
const BSE_FIELDS = {
  phys_ucc:
    "This scheme can only be held physically, but your BSE account is registered for demat only. Ask support to register it for both.",
};
const bseMessages = (r) =>
  (Array.isArray(r?.messages) ? r.messages : [])
    .map((m) => {
      const field = String(m?.field || "field").split(".").pop();
      if (BSE_FIELDS[field]) return BSE_FIELDS[field];
      const code = String(m?.errcode || "invalid");
      const base = `${field} ${BSE_ERRCODES[code] || `is ${code}`}`;
      // BSE `vals` mein asli wajah likh deta hai ("No valid responses generated..."),
      // aur hum use phenk rahe the. Sirf jumle uthao, code/flag nahi.
      const why = (Array.isArray(m?.vals) ? m.vals : []).find((v) => typeof v === "string" && v.includes(" "));
      return why ? `${base} — ${why}` : base;
    })
    .join("; ");

// ponytail: SDK ka _postRequest error ko nigal kar body return kar deta hai, throw nahi karta.
// Is liye sirf explicit failure marker par error banao — success/absent status ko haath mat lagao,
// warna jo endpoints abhi chal rahe hain wo tut jayenge.
const bseFailure = (r) => {
  const s = String(r?.status ?? "").toLowerCase();
  const items = Array.isArray(r?.data?.items) ? r.data.items : [];
  const bad = items.find((i) => /error|fail|reject/.test(String(i?.status ?? "").toLowerCase()));
  if (s !== "error" && s !== "failure" && s !== "failed" && !bad) return null;
  return String(
    r?.message || bseMessages(r) || bad?.message || bad?.remarks || r?.data?.message || "BSE rejected the request"
  );
};

// ponytail: BSE ka asli reason nikalta hai — UI aur logs dono `message` padhte hain
const bseMessage = (error) => {
  const d = error?.response?.data;
  return String(
    // messages[] BSE ki asli shakl hai; iske bagair axios ka "Request failed with
    // status code 400" bacha reh jata hai, jo user ko kuch nahi batata.
    d?.message || bseMessages(d) || d?.data?.message || d?.errors?.[0]?.message ||
    error?.message || error?.code || "BSE request failed"
  );
};

// ponytail: browser is prefix par aata hai — container nginx `/api/bse/` ko backend ke
// `/api/` par bhejta hai, aur `/pg/*` proxy route wahan baitha hai. Alag domain par
// deploy karo to PUBLIC_PG_PREFIX env se override kar lena.
const PUBLIC_PG_PREFIX = process.env.PUBLIC_PG_PREFIX || "/api/bse/pg";

class StarMFController {
  constructor() {
    this.loginService = new StarMFService.BseLoginService({
      baseUrl: configData.baseUrl,
    });
    this.uccService = new StarMFService.UccService({
      baseUrl: configData.baseUrl,
    });
    this.trxnService = new StarMFService.TrxnService({
      baseUrl: configData.baseUrl,
    });
    this.mandatteService = new StarMFService.MandateService({
      baseUrl: configData.baseUrl,
    });
    this.paymentService = new StarMFService.PaymentService({
      baseUrl: configData.baseUrl,
    });
    this.masterDataService = new StarMFService.MasterDataService({
      baseUrl: configData.baseUrl,
    });
    this.nftService = new StarMFService.NFTService({
      baseUrl: configData.baseUrl,
    });
    this.fetch2FALinkService = new StarMFService.Fetch2FALinkService({
      baseUrl: configData.baseUrl,
    });
    this.navService = new StarMFService.NavService({
      baseUrl: configData.baseUrl,
    });
    // this.loginService = new BseLoginService({ baseUrl: configData.baseUrl });
    // this.uccService = new UccService({ baseUrl: configData.baseUrl });
    // this.trxnService = new TrxnService({ baseUrl: configData.baseUrl });
    // this.mandatteService = new MandateService({ baseUrl: configData.baseUrl });
    // this.paymentService = new PaymentService({ baseUrl: configData.baseUrl });
    // this.masterDataService = new MasterDataService({
    //   baseUrl: configData.baseUrl,
    // });
    this.username = configData.username;
    this.password = configData.password;
    this.baseUrl = configData.baseUrl;
    this.memberCode = configData.memberCode;
    this.accessToken = null; //need to check for token expiration time
    this.tokenExpiry = "";
    // ponytail: follow BSE_BASE_URL (demo|prod) — was hardcoded demo while .env used prod
    this.bseDemoUrl = `${String(configData.baseUrl).replace(/\/$/, "")}/api`;
    this.bseToken = "";
    this.insecureAgent = new https.Agent({ rejectUnauthorized: false });
    [
      this.loginService,
      this.uccService,
      this.trxnService,
      this.mandatteService,
      this.paymentService,
      this.masterDataService,
      this.nftService,
      this.fetch2FALinkService,
      this.navService,
    ].forEach((svc) => {
      const ax = svc?.api?._axios;
      if (!ax) return;
      ax.defaults.httpsAgent = this.insecureAgent;
      ax.interceptors.request.use((config) => {
        config.httpsAgent = this.insecureAgent;
        return config;
      });
    });
  }

  // Direct Axios BSE Login
  login = async (req, res) => {
    const { username, password } = req.body;
    try {
      const authUser = username || this.username;
      const authPass = password || this.password;

      console.log('Attempting BSE Login for:', authUser);
      const response = await axios.post(`${this.bseDemoUrl}/login`, {
        data: {
          username: authUser,
          password: authPass
        }
      });

      const token = response.data?.data?.access_token || response.data?.accessToken || response.data?.data?.accessToken || response.data?.token || response.data?.data?.token;

      if (token) {
        this.bseToken = token;
        console.log('BSE Login Successful. Token updated.');
        res.json({ message: 'Login successful', token: this.bseToken });
      } else {
        console.error('BSE Login failed: Token not found in response', response.data);
        res.status(401).json({ message: 'Login failed', error: 'Token not found in response' });
      }
    } catch (error) {
      const errorMsg = error.response?.data?.message || error.message;
      console.error('BSE Login Error:', errorMsg);
      res.status(500).json({ message: 'Server error during login', error: errorMsg });
    }
  };

  // Direct Axios BSE Add UCC
  addUcc = async (req, res) => {
    const {
      client_code,
      first_name,
      middle_name = "",
      last_name,
      dob,
      mobile,
      email,
      pan,
      dp_id,
      client_id,
      address = {},
      bank = {},
    } = req.body;

    // T1.5 — Validate address.line1 minimum 8 chars (before any BSE call)
    if (!address.line1 || address.line1.trim().length < 8) {
      return res.status(400).json({
        error: 'Validation failed',
        field: 'address.line1',
        message: 'Address line 1 must be at least 8 characters'
      });
    }

    // T1.6 — Validate pincode is a valid 6-digit India postal code
    const PINCODE_REGEX = /^[1-9][0-9]{5}$/;
    if (!address.pincode || !PINCODE_REGEX.test(address.pincode)) {
      return res.status(400).json({
        error: 'Validation failed',
        field: 'address.pincode',
        message: 'Pincode must be a valid 6-digit India postal code'
      });
    }

    const makeRequest = async () => {
      if (!this.bseToken) {
        // Auto login if no token
        const loginResp = await axios.post(`${this.bseDemoUrl}/login`, {
          data: {
            username: this.username,
            password: this.password
          }
        });
        this.bseToken = loginResp.data?.data?.access_token || loginResp.data?.token;
      }

      // Prepare the specific structure required by BSE
      const bseBody = {
          "data": {
              "investor": {
                  "client_code": client_code || "FOFTest1"
              },
              "pms_client": false,
              "pms_code": "",
              "holding_nature": "SI",
              "tax_code": "01",
              "rdmp_idcw_pay_mode": "02",
              "is_client_physical": false,
              "is_client_demat": true,
              "is_nomination_opted": false,
              "nomination_auth_mode": "O",
              "comm_mode": "E",
              "onboarding": "Z",
              "holder": [
                  {
                      "holder_rank": "1",
                      "occ_code": "02",
                      "auth_mode": "M",
                      "is_pan_exempt": false,
                      "pan_exempt_category": "",
                      "identifier": [
                          {
                              "identifier_type": "pan",
                              "identifier_number": pan || "NYTPA0008A"
                          },
                          {
                              "identifier_type": "accredited_investor",
                              "identifier_number": "9884520120",
                              "expiry_date": "2028-02-23"
                          }
                      ],
                      "kyc_type": "K",
                      "ckyc_number": "",
                      "person": {
                          "first_name": first_name || "vaibhav",
                          "middle_name": middle_name || "rajan",
                          "last_name": last_name || "shirsath",
                          "dob": dob || "2000-01-12",
                          "gender": "M"
                      },
                      "contact": [
                          {
                              "contact_number": mobile || "9912345678",
                              "country_code": "91",
                              "whose_contact_number": "SE",
                              "email_address": email || "v2001@gmail.com",
                              "whose_email_address": "SE",
                              "contact_type": "PR"
                          }
                      ]
                  }
              ],
              "comm_addr": {
                  "address_line_1": address.line1 || "Flat No. 102, ABC Apartments",
                  "address_line_2": address.line2 || "Rajpur Road",
                  "address_line_3": address.line3 || "Uttarakhand",
                  "postalcode": address.pincode || "248001",
                  "country": "INDIA"
              },
              "depository": [
                  {
                      "depository_code": "CDSL",
                      "dp_id": String(dp_id || "12345678"),
                      "client_id": String(client_id || "12345678"),
                      "bank_account": bank.acc_no || "6986598569865",
                      "account_owner": "SELF"
                  }
              ],
              "bank_account": [
                  {
                      "ifsc_code": bank.ifsc || "UTIB0000004",
                      "bank_acc_num": bank.acc_no || "6986598569865",
                      "bank_acc_type": bank.acc_type || "SB",
                      "account_owner": "SELF"
                  }
              ],
              "fatca": [
                  {
                      "holder_rank": "1",
                      "place_of_birth": req.body.place_of_birth || "New York City",
                      "country_of_birth": "IND",
                      "client_name": first_name || "vaibhav",
                      "investor_type": "Individual",
                      "dob": dob || "2000-01-12",
                      "address_type": "1",
                      "occ_code": "01",
                      "occ_type": "B",
                      "tax_status": "Individual",
                      "identifier": {
                          "identifier_type": "pan",
                          "identifier_number": pan || "NYTPA0008A"
                      },
                      "wealth_source": "1",
                      "income_slab": "32",
                      "politically_exposed": "N",
                      "is_self_declared": true,
                      "data_source": "P",
                      "tax_residency": [
                          {
                              "country": "IND",
                              "tax_id_no": pan || "NYTPA0008A",
                              "tax_id_type": "C"
                          }
                      ]
                  }
              ]
          }
      };

      console.log("Sending to BSE Demo:", JSON.stringify(bseBody, null, 2));

      const response = await axios.post(`${this.bseDemoUrl}/v2/add_ucc`, bseBody, {
        headers: {
          'Authorization': `Bearer ${this.bseToken}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    };

    try {
      const responseData = await makeRequest();
      res.json(responseData);
    } catch (error) {
      const isUnauthorized = error.response?.status === 401 || 
                             error.message?.includes('401') || 
                             (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes("401 Authorization Required"));
      
      if (isUnauthorized) {
        console.log('BSE Token expired/invalid during add_ucc, re-logging and retrying once...');
        this.bseToken = '';
        try {
          const responseData = await makeRequest();
          return res.json(responseData);
        } catch (retryError) {
          console.error("BSE ERROR DETAILS AFTER RETRY:", JSON.stringify(retryError.response?.data, null, 2));
          const retryBseMessages = retryError.response?.data?.messages || [];
          if (retryBseMessages.length > 0) {
            const BSE_ERROR_MAP = {
              526: { field: 'address.line1', message: 'Address line 1 is too short — minimum 8 characters required', fix: 'Enter a more detailed address' },
              560: { field: 'address.pincode', message: 'Invalid pincode — this postal code does not exist in India', fix: 'Use a valid 6-digit India pincode' },
            };
            const mappedErrors = retryBseMessages.map(msg => BSE_ERROR_MAP[msg.msgid] || { field: msg.field, message: msg.errcode, fix: 'Check the field and try again' });
            return res.status(400).json({ error: 'BSE validation failed', errors: mappedErrors, raw: retryBseMessages });
          }
          return res.status(500).json({ error: 'Failed to add UCC at BSE Demo after retry', details: retryError.response?.data || retryError.message });
        }
      }
      console.error("BSE ERROR DETAILS:", JSON.stringify(error.response?.data, null, 2));

      // T1.9 — Map BSE error codes to user-friendly messages
      const bseMessages = error.response?.data?.messages || [];
      if (bseMessages.length > 0) {
        const BSE_ERROR_MAP = {
          526: { field: 'address.line1', message: 'Address line 1 is too short — minimum 8 characters required', fix: 'Enter a more detailed address (e.g. "Flat 12, Green Park Society")' },
          560: { field: 'address.pincode', message: 'Invalid pincode — this postal code does not exist in India', fix: 'Use a valid 6-digit India pincode (e.g. 700091)' },
        };
        const mappedErrors = bseMessages.map(msg => BSE_ERROR_MAP[msg.msgid] || { field: msg.field, message: msg.errcode, fix: 'Check the field and try again' });
        return res.status(400).json({ error: 'BSE validation failed', errors: mappedErrors, raw: bseMessages });
      }

      res.status(500).json({ error: 'Failed to add UCC at BSE Demo', details: error.response?.data || error.message });
    }
  };

  async loginFunc() {
    if (!this.username || !this.password) {
      return { status: "error", message: "BSE credentials not configured" };
    }
    try {
      const response = await axios.post(
        `${this.bseDemoUrl}/login`,
        { data: { username: this.username, password: this.password } },
        { httpsAgent: this.insecureAgent, timeout: 30000 }
      );
      const data = response.data || {};
      this.accessToken =
        data?.data?.access_token ||
        data?.data?.accessToken ||
        data?.access_token ||
        data?.accessToken ||
        data?.token ||
        null;
      if (!this.accessToken) {
        return {
          status: "error",
          message: data?.message || "BSE login returned no token",
          detail: data,
        };
      }
      return data.status ? data : { status: "success", data: { access_token: this.accessToken } };
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.message ||
        error.code ||
        "BSE login failed";
      console.error("BSE login failed:", message);
      return { status: "error", message: String(message), detail: error.response?.data || null };
    }
  }

  async executeWithRetry(serviceInstance, serviceMethod, reqObj, res) {
    let loginResp;
    loginResp = await this.loginFunc();
    if (loginResp?.status === "error") {
      return res.status(502).json(loginResp);
    }
    
    const requestData = reqObj;
    console.log(`Payload for ${serviceMethod}:`, JSON.stringify(requestData, null, 2));

    try {
      const response = await this[serviceInstance][serviceMethod](
        this.accessToken,
        requestData
      );
      console.log(`Response for ${serviceMethod}:`, JSON.stringify(response).slice(0, 2000));
      const failure = bseFailure(response);
      if (failure) {
        console.error(`BSE rejected ${serviceMethod}:`, failure);
        return res.status(502).json({ status: "error", message: failure, detail: response });
      }
      return res.json(response);
    } catch (error) {
      const isUnauthorized = error.response?.status === 401 || 
                             error.message?.includes('401') || 
                             (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes("401 Authorization Required"));
      
      if (isUnauthorized) {
        console.log(`[Token Expired] Received 401 from BSE gateway in ${serviceMethod}. Refreshing token...`);
        this.accessToken = null;
        loginResp = await this.loginFunc();
        if (loginResp?.status === "error") {
          return res.status(502).json(loginResp);
        }
        try {
          console.log(`[Token Expired] Retrying ${serviceMethod} with new token...`);
          const response = await this[serviceInstance][serviceMethod](
            this.accessToken,
            requestData
          );
          return res.json(response);
        } catch (retryError) {
          console.error(`Error in ${serviceMethod} after token refresh:`, retryError);
          // ponytail: message field bhi chahiye — UI isi ko padhta hai, details ko nahi
          return res.status(500).json({ status: "error", error: "Internal Server Error after token refresh", message: bseMessage(retryError), details: retryError.message });
        }
      }
      
      console.error(`Error in ${serviceMethod}:`, error);
      return res.status(500).json({ status: "error", error: "Internal Server Error", message: bseMessage(error), details: error.message });
    }
  }

  async handleUccRequest(serviceMethod, reqObj, res) {
    return this.executeWithRetry("uccService", serviceMethod, reqObj, res);
  }

  /**
   * Helper to fetch and calculate returns for a specific scheme
   */
  async calculateReturns(code, currentNav) {
    const today = new Date();
    const getPastDate = (y) => {
      const d = new Date();
      d.setFullYear(today.getFullYear() - y);
      return d;
    };

    const [nav1Y, nav3Y, nav5Y] = await Promise.all([
      this.fetchNavsForDate(getPastDate(1)),
      this.fetchNavsForDate(getPastDate(3)),
      this.fetchNavsForDate(getPastDate(5))
    ]);

    const maps = {
      "1Y": this.createNavMap(nav1Y?.data?.lists || []),
      "3Y": this.createNavMap(nav3Y?.data?.lists || []),
      "5Y": this.createNavMap(nav5Y?.data?.lists || [])
    };

    const calc = (pastMap, years) => {
      const pastNav = parseFloat(pastMap[code]?.nav);
      if (currentNav && pastNav && pastNav > 0) {
        if (years === 1) return parseFloat((((currentNav - pastNav) / pastNav) * 100).toFixed(2));
        return parseFloat(((Math.pow(currentNav / pastNav, 1 / years) - 1) * 100).toFixed(2));
      }
      return null;
    };

    return {
      "1Y": calc(maps["1Y"], 1),
      "3Y": calc(maps["3Y"], 3),
      "5Y": calc(maps["5Y"], 5)
    };
  }

  async handleTrxnRequest(serviceMethod, reqObj, res) {
    return this.executeWithRetry("trxnService", serviceMethod, reqObj, res);
  }

  async handleMandateRequest(serviceMethod, req, res) {
    return this.executeWithRetry("mandatteService", serviceMethod, req, res);
  }

  async handlePaymentRequest(serviceMethod, reqObj, res) {
    return this.executeWithRetry("paymentService", serviceMethod, reqObj, res);
  }

  async handleMasterDataRequest(serviceMethod, reqObj, res) {
    return this.executeWithRetry("masterDataService", serviceMethod, reqObj, res);
  }

  async handleNFTRequest(serviceMethod, reqObj, res) {
    return this.executeWithRetry("nftService", serviceMethod, reqObj, res);
  }

  async handleFetch2FALinkRequest(serviceMethod, reqObj, res) {
    return this.executeWithRetry("fetch2FALinkService", serviceMethod, reqObj, res);
  }

  async handleNavRequest(serviceMethod, reqObj, res) {
    return this.executeWithRetry("navService", serviceMethod, reqObj, res);
  }

  loginRequest = async (req, res) => {
    try {
      const loginResp = await this.loginService.login(
        this.username,
        this.password
      );
      console.log("loginResp", loginResp);
      res.json(loginResp);
    } catch (error) {
      // console.error(`Error in ${serviceMethod}:`, error);
      res
        .status(500)
        .json({ error: "Internal Server Error", details: error.message });
    }
  };

  // UCC Methods
  getAllUcc = async (req, res) => {
    let reqObj = uccRequestData.getAllUcc;
    return this.handleUccRequest("getAllUcc", reqObj, res);
  };
  
  createPhysicalUcc = async (req, res) => {
    const reqObj = req.body && Object.keys(req.body).length ? req.body : uccRequestData.createPhysicalUcc;
    return this.handleUccRequest("createPhysicalUcc", reqObj, res);
  };
  createDematUcc = async (req, res) => {
    let reqObj = uccRequestData.createDematUcc;
    return this.handleUccRequest("createDematUcc", reqObj, res);
  };
  createBothUcc = async (req, res) => {
    let reqObj = uccRequestData.createBothUcc;
    return this.handleUccRequest("createBothUcc", reqObj, res);
  };
  updateUccAddress = async (req, res) => {
    let reqObj = uccRequestData.updateUccAddress;
    return this.handleUccRequest("updateUccAddress", reqObj, res);
  };
  updateUccProfile = async (req, res) => {
    let reqObj = uccRequestData.updateUccProfile;
    return this.handleUccRequest("updateUccProfile", reqObj, res);
  };
  updateUccUpdateBankData = async (req, res) => {
    let reqObj = uccRequestData.updateUccUpdateBankData;
    return this.handleUccRequest("updateUccUpdateBankData", reqObj, res);
  };
  deactivateUcc = async (req, res) => {
    let reqObj = uccRequestData.deactivateUcc;
    return this.handleUccRequest("deactivateUcc", reqObj, res);
  };

  // // Mandate Methods
  registerMandate = async (req, res) => {
    let reqObj = mandateRequestData.registerMandate;
    return this.handleMandateRequest("registerMandate", reqObj, res);
  };

  registerMandateUPI = async (req, res) => {
    let reqObj = mandateRequestData.registerMandateUPI;
    return this.handleMandateRequest("registerMandateUPI", reqObj, res);
  };

  registerMandateEnach = async (req, res) => {
    let reqObj = mandateRequestData.registerMandateEnach;
    return this.handleMandateRequest("registerMandateEnach", reqObj, res);
  };

  registerMandateNach = async (req, res) => {
    let reqObj = mandateRequestData.registerMandateNach;
    return this.handleMandateRequest("registerMandateNach", reqObj, res);
  };

  getMandate = async (req, res) => {
    let reqObj = mandateRequestData.getMandate;
    return this.handleMandateRequest("getMandate", reqObj, res);
  };

  getAllMandate = async (req, res) => {
    let reqObj = mandateRequestData.getAllMandate;
    return this.handleMandateRequest("getAllMandate", reqObj, res);
  };

  cancelMandate = async (req, res) => {
    let reqObj = mandateRequestData.cancelMandate;
    return this.handleMandateRequest("cancelMandate", reqObj, res);
  };

  linkMandate = async (req, res) => {
    let reqObj = mandateRequestData.linkMandate;
    return this.handleMandateRequest("linkMandate", reqObj, res);
  };

  mandateDelink = async (req, res) => {
    let reqObj = mandateRequestData.mandateDelink;
    return this.handleMandateRequest("mandateDelink", reqObj, res);
  };

  updateMandate = async (req, res) => {
    let reqObj = mandateRequestData.updateMandate;
    return this.handleMandateRequest("updateMandate", reqObj, res);
  };

  // XSP Methods
  xspRegister = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : xspRequestData.xspRegisterData;
    return this.handleTrxnRequest("xspRegister", reqObj, res);
  };
  getXsp = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : xspRequestData.getXspData;
    return this.handleTrxnRequest("getXsp", reqObj, res);
  };
  pauseXsp = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : xspRequestData.pauseXspData;
    return this.handleTrxnRequest("pauseXsp", reqObj, res);
  };
  cancelXsp = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : xspRequestData.cancelXspData;
    return this.handleTrxnRequest("cancelXsp", reqObj, res);
  };
  getAllXsp = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : xspRequestData.getAllXspData;
    return this.handleTrxnRequest("getAllXsp", reqObj, res);
  };
  topupXsp = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : xspRequestData.topupXspData;
    return this.handleTrxnRequest("topupXsp", reqObj, res);
  };

  resumeXsp = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : xspRequestData.resumeXsp;
    return this.handleTrxnRequest("resumeXsp", reqObj, res);
  };

  getXspTrxnHistory = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : xspRequestData.getXspTrxnHistory;
    return this.handleTrxnRequest("getXspTrxnHistory", reqObj, res);
  };

  // Order Methods
  purchaseNewOrder = async (req, res) => {
    if (!req.body || !Object.keys(req.body).length) {
      return res.status(400).json({ status: "error", message: "Order payload is required" });
    }
    const parsed = validateOrder(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ status: "error", message: parsed.error });
    }
    const ucc = req.ucc || investorUcc(req.investor);
    const scheme = await this.lookupScheme(parsed.order.scheme);
    const limits = checkSchemeLimits(parsed.order, scheme);
    if (!limits.ok) {
      return res.status(400).json({ status: "error", message: limits.error });
    }
    const mobile = investorMobile(req.investor) || normalizeMobile(parsed.order.mobnum);
    if (!mobile) {
      return res.status(400).json({
        status: "error",
        message: "A valid 10-digit Indian mobile number is required. Update it in your profile before investing.",
      });
    }
    const dp = parsed.order.depository_acct?.dp_id ? parsed.order.depository_acct : await this.lookupDepository(ucc);
    const normalized = normalizeOrder(
      {
        ...parsed.order,
        // Purane link us code par khule rehte hain jo BSE ab nahi janta — resolved row
        // ka code bhejo, warna wapas record_not_found.
        scheme: scheme?.scheme_bse_code || parsed.order.scheme,
        depository_acct: dp || {},
      },
      {
        ucc,
        memberCode: this.memberCode,
        mobile,
        modes: allowedModes(scheme, String(parsed.order.type).toLowerCase() === "r" ? "Redemption" : "Purchase"),
      }
    );
    const blocked = uccBlocks(await this.lookupUcc(ucc), normalized.phys_or_demat);
    if (blocked) return res.status(400).json({ status: "error", message: blocked });
    const reqObj = { data: { orders: [normalized] } };
    return this.handleTrxnRequest("purchaseNewOrder", reqObj, res);
  };
  updatePurchaseOrder = async (req, res) => {
    if (!req.body || !Object.keys(req.body).length) {
      return res.status(400).json({ status: "error", message: "Order payload is required" });
    }
    return this.handleTrxnRequest("updatePurchaseOrder", bindUcc(req.body, req.ucc, this.memberCode), res);
  };
  getAllOrders = async (req, res) => {
    if (!req.body || !Object.keys(req.body).length) {
      return res.status(400).json({ status: "error", message: "Filter payload is required" });
    }
    return this.handleTrxnRequest("getAllOrders", req.body, res);
  };
  getOrder = async (req, res) => {
    if (!req.body || !Object.keys(req.body).length) {
      return res.status(400).json({ status: "error", message: "Order id is required" });
    }
    return this.handleTrxnRequest("getOrder", req.body, res);
  };

  getClientPortfolio = async (req, res) => {
    try {
      const ucc = req.ucc || investorUcc(req.investor) || req.body?.data?.ucc || req.body?.ucc;
      if (!ucc) {
        return res.status(400).json({ status: "error", message: "ucc is required" });
      }
      const reqObj = {
        data: {
          fields: ["ALL"],
          start: 0,
          length: 100,
          // ponytail: sirf yehi shape BSE accept karta hai — member_code filter_param ke
          // andar string, aur open_close lowercase "o". Data level par member_code (string
          // ya object) "required" deta hai, array/object filter mein "invalid_json".
          // status filter yahan mat bhejo, wo unproven hai — neeche JS mein filter karte hain.
          filter_param: { ucc: [ucc], member_code: this.memberCode, open_close: "o" },
        },
      };
      const result = await new Promise((resolve, reject) => {
        this.handleTrxnRequest("getAllOrders", reqObj, {
          json: (data) => resolve(data),
          status: (code) => ({ json: (data) => resolve({ ...data, _status: code }) }),
        });
      });
      // ponytail: order_list `data.lists` deta hai, `items` nahi — success response se
      // confirmed. Purane keys fallback ke taur par rakhe hain.
      const HELD = new Set(["ALLOTTED", "ACCEPTED", "PAID"]);
      const rows = result?.data?.lists || result?.data?.items || result?.items || [];
      const items = rows.filter((o) => !o?.status || HELD.has(String(o.status).toUpperCase()));
      const holdings = items.map((o) => ({
        // ponytail: BSE ke apne key naam — order_list `src_scheme_name` aur `folio_num`
        // deta hai. Purane naam pehle padhe ja rahe the, is liye folio hamesha khali
        // milta tha aur redeem "Folio is missing" par ruk jata.
        scheme_name: o.src_scheme_name || o.scheme_name || o.scheme,
        scheme_bse_code: o.scheme,
        inv_amo: Number(o.amount || 0),
        folio: o.folio_num || o.folio || "",
        units: Number(o.units || 0),
        nav: Number(o.nav || 0),
        status: o.status,
        ret_percentage: 0,
        scheme_category: o.scheme_category || "Mutual Fund",
      }));
      // ponytail: unpaid orders holding nahi hain, magar UI ko farq batana hai —
      // "kuch invest hi nahi kiya" aur "payment adhoori hai" ek jaisa nahi dikhna chahiye.
      const pending = rows.length - items.length;
      return res.json({ status: "success", data: { holdings, count: holdings.length, pending } });
    } catch (error) {
      return res.status(500).json({ status: "error", message: error.message });
    }
  };
  cancelPurchaseOrder = async (req, res) => {
    if (!req.body || !Object.keys(req.body).length) {
      return res.status(400).json({ status: "error", message: "Order id is required" });
    }
    return this.handleTrxnRequest("cancelPurchaseOrder", bindUcc(req.body, req.ucc, this.memberCode), res);
  };
  listPaymentDetail = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : orderRequestData.listPaymentDetail;
    return this.handleTrxnRequest("listPaymentDetail", reqObj, res);
  };
  getPaymentDetail = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : orderRequestData.getPaymentDetail;
    return this.handleTrxnRequest("getPaymentDetail", reqObj, res);
  };

  // // Payment Methods
  uploadMis = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : paymentRequestData.uploadMis;
    this.handlePaymentRequest("paymentReport", reqObj, res);
  };
  getMisDetails = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : paymentRequestData.getMisDetails;
    this.handlePaymentRequest("getPaymentMisDetails", reqObj, res);
  };

  // ponytail: holding mode ka source of truth BSE hai, hamari DB nahi. Demat UCC par
  // order bina depository_acct ke reject hota hai (msgid 1522) aur "P" bhejna bhi
  // not_allowed hai. UCC shayad hi badalta hai, is liye process-level cache — stale
  // lage to container restart kaafi hai, TTL ki zaroorat tab hai jab DP details badlein.
  // ponytail: 60s TTL — UCC verify hone par cache khud bhool jaye, warna "pending"
  // hamesha ke liye chipak jata hai aur theek hone ke baad bhi order rukta rehta hai.
  _uccCache = {};
  async lookupUcc(ucc) {
    if (!ucc) return null;
    const hit = this._uccCache[ucc];
    if (hit && Date.now() < hit.exp) return hit.data;
    let info = null;
    try {
      if (!this.accessToken) await this.loginFunc();
      const { data } = await axios.post(
        `${this.bseDemoUrl}/v2/get_ucc`,
        { data: { member_code: { member_id: this.memberCode }, investor: { client_code: ucc } } },
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
      info = data?.data || null;
    } catch (error) {
      console.error("UCC lookup failed:", bseMessage(error));
    }
    this._uccCache[ucc] = { data: info, exp: Date.now() + 60000 };
    return info;
  }

  async lookupDepository(ucc) {
    const info = await this.lookupUcc(ucc);
    const acct = (info?.depository || []).find((d) => d?.dp_id && d?.client_id);
    if (!acct) return null;
    // ponytail: key `depository` hai (iske bagair "required" aata hai), lekin value
    // UCC wala "CDSL" nahi — usay BSE "invalid" kehta hai. StarMF single-letter code
    // leta hai: CDSL=C, NSDL=N. Aur koi depository hai nahi, is liye do-tarfa map bas.
    const code = String(acct.depository_code || "").toUpperCase();
    return { depository: code.startsWith("N") ? "N" : "C", dp_id: acct.dp_id, client_id: acct.client_id };
  }

  async lookupScheme(code) {
    if (!code) return null;
    const needle = String(code).trim().toUpperCase();
    const reqObj = {
      data: { start: 0, length: 50, fields: ["ALL"], count_only: false, filter_param: {}, search: { value: needle } },
    };
    await this.loginFunc();
    const schemesRes = await this.masterDataService.getSchemeMasterList(this.accessToken, reqObj);
    const lists = schemesRes?.data?.lists || [];
    const codeOf = (r) => String(r?.scheme_bse_code || r?.bse_scheme_code || "").trim().toUpperCase();
    const isinOf = (r) => String(r?.scheme_isin || r?.isin || "").trim().toUpperCase();
    const matches = lists.filter((r) => codeOf(r) === needle || isinOf(r) === needle);
    const live = matches.find(isTransactable);
    if (live) return live;
    const dead = matches[0];
    if (!dead) return null;
    // ponytail: BSE purane code ka mara hua row bhi rakhta hai (011-DP, is_active false)
    // jab ke chalta hua row naye code par hota hai (FR011-DP). Wahi ISIN + wahi code
    // suffix = wahi scheme, wahi plan/option — DP kabhi DR nahi ban jayega.
    return (
      lists.find((r) => isTransactable(r) && isinOf(r) === isinOf(dead) && codeOf(r).endsWith(needle)) ||
      dead
    );
  }

  getSchemeMasterList = async (req, res) => {
    const q = parseListQuery(req.body || {});
    const cacheKey = listCacheKey(q);
    const cached = getListCache(cacheKey);
    if (cached) return res.json(cached);

    try {
      const { list, total: fetched, unpriced, fields, sample } = await getCatalogue(this, q);
      // Page already comes from BSE; only filter this page (don't re-slice start).
      const { lists } = query(list, { category: q.category, isin: q.isin, scheme_code: q.scheme_code, start: 0, length: q.length });
      const total = fetched || lists.length;
      const lookedUp = q.search || q.isin || q.scheme_code || q.category;
      if (!lists.length && !fetched && !lookedUp) {
        return res.status(502).json({ status: "error", message: "BSE scheme list unavailable" });
      }
      const payload = {
        status: "success",
        data: {
          count: total,
          total,
          start: q.start,
          length: q.length,
          // Every scheme in `lists` is priced; `unpriced` are matured/wound-up
          // schemes dropped from the catalogue, surfaced here for observability.
          catalogue: { priced: list.length, fetched, unpriced, fields, sample },
          lists,
        },
      };
      setListCache(cacheKey, payload);
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
  };

  /**
   * Get Detailed info for a particular fund including Chart data and Advanced Ratios
   */
  getSchemeDetails = async (req, res) => {
    try {
      const { isin, scheme_code } = req.body;
      if (!isin && !scheme_code) {
        return res.status(400).json({ status: "error", message: "isin or scheme_code is required" });
      }

      if (!this.accessToken) await this.loginFunc();

      const searchBse = async (value) => {
        const reqObj = JSON.parse(JSON.stringify(schemeRequestData.getSchemeMasterList));
        reqObj.data.search = { value };
        try {
          return await this.masterDataService.getSchemeMasterList(this.accessToken, reqObj);
        } catch (error) {
          const isUnauthorized = error.response?.status === 401 ||
                                 error.message?.includes("401") ||
                                 (error.response?.data && typeof error.response.data === "string" && error.response.data.includes("401 Authorization Required"));
          if (!isUnauthorized) throw error;
          this.accessToken = null;
          await this.loginFunc();
          return this.masterDataService.getSchemeMasterList(this.accessToken, reqObj);
        }
      };

      const needles = [...new Set([isin, scheme_code].filter(Boolean))];
      let scheme = null;
      for (const value of needles) {
        const schemesRes = await searchBse(value);
        scheme = pickScheme(schemesRes?.data?.lists || [], isin, scheme_code);
        if (scheme) break;
      }
      if (!scheme) return res.status(404).json({ status: "error", message: "Scheme not found" });
      const mapped = mapScheme(scheme);
      if (mapped.minSip == null) mapped.minSip = 500;
      if (mapped.minLumpsum == null) mapped.minLumpsum = 5000;

      let mf = null;
      try {
        mf = await loadFundNav(isin || mapped.scheme_isin, mapped.name);
      } catch (e) {
        console.error("mfapi load failed", e.message);
      }

      const { navs } = await getNavs(this);
      const navKeys = [isin || mapped.scheme_isin, scheme_code || mapped.scheme_bse_code];
      const bseNav = navFor(navs, ...navKeys);
      const navDate = navDateFor(navs, ...navKeys);
      const currentNav = bseNav || mf?.currentNav || mapped.nav || null;
      const returns = mf?.returns || calcReturns(currentNav, {});
      const realSeries = mf?.chartData?.length ? mf.chartData : [];
      const chartData = realSeries.length ? realSeries : buildChartSeries(currentNav, returns);

      const profile = fundProfile(mapped.name, `${mapped.category} ${mf?.meta?.scheme_category || ""}`);
      const ratios = ratiosFromSeries(mf?.series || [], profile.holdings);
      // ponytail: skip peer NAV fan-out — nginx times out scheme-details
      const categoryAvg = { "1Y": null, "3Y": null, "5Y": null, ALL: null };
      const rank = { "1Y": null, "3Y": null, "5Y": null, ALL: null };

      return res.json({
        status: "success",
        data: {
          scheme_info: {
            ...mapped,
            isin: mapped.scheme_isin || isin,
            scheme_code: mapped.scheme_bse_code || scheme_code,
            current_nav: currentNav,
            nav_date: navDate,
            returns,
            advancedRatios: ratios,
            holdings: profile.holdings,
          },
          returns,
          chartData,
          synthetic: !realSeries.length,
          holdings: profile.holdings,
          assetSplit: profile.assetSplit,
          sectors: profile.sectors,
          categoryAvg,
          rank,
        }
      });

    } catch (error) {
      console.error("Get Scheme Details Error:", error);
      return res.status(500).json({ status: "error", message: error.message });
    }
  };

  // NFT Service Method

  nftBankAccountChange = async (req, res) => {
    let reqObj = nftRequestData.nftBankAccountChange;
    return this.handleNFTRequest("nftBankAccountChange", reqObj, res);
  };
  nftNomineeChange = async (req, res) => {
    let reqObj = nftRequestData.nftNomineeChange;
    return this.handleNFTRequest("nftNomineeChange", reqObj, res);
  };
  nftContactChange = async (req, res) => {
    let reqObj = nftRequestData.nftContactChange;
    return this.handleNFTRequest("nftContactChange", reqObj, res);
  };

  // Fetch 2FA Link Service

  get2FAUccNom = async (req, res) => {
    return this.fetch2FAUcc("get2FAUccNom", "UCC_NOM", req, res);
  };

  get2FAUccElog = async (req, res) => {
    return this.fetch2FAUcc("get2FAUccElog", "UCC_ELOG", req, res);
  };

  async fetch2FAUcc(serviceMethod, event, req, res) {
    const ucc = req.ucc || investorUcc(req.investor);
    if (!ucc) return res.status(400).json({ status: "error", message: "UCC is required" });
    const reqObj = twoFaUccPayload(event, {
      ucc,
      info: await this.lookupUcc(ucc),
      memberCode: this.memberCode,
    });
    return this.handleFetch2FALinkRequest(serviceMethod, reqObj, res);
  }

  get2FAVerifyMandateCancel = async (req, res) => {
    let reqObj = fetch2FALinkRequestData.get2FAVerifyMandateCancel;
    return this.handleFetch2FALinkRequest(
      "get2FAVerifyMandateCancel",
      reqObj,
      res
    );
  };

  get2FAVerifySxpReg = async (req, res) => {
    let reqObj = fetch2FALinkRequestData.get2FAVerifySxpReg;
    return this.handleFetch2FALinkRequest("get2FAVerifySxpReg", reqObj, res);
  };

  get2FAVerifyOrderCancel = async (req, res) => {
    let reqObj = fetch2FALinkRequestData.get2FAVerifyOrderCancel;
    return this.handleFetch2FALinkRequest(
      "get2FAVerifyOrderCancel",
      reqObj,
      res
    );
  };

  getExchPgService = async (req, res) => {
    // use sample requestData or override with req.body
    const reqObj = req.body && Object.keys(req.body).length ? req.body : paymentRequestData.getExchPgService;
    return this.handlePaymentRequest("getExchPgService", reqObj, res);
  };

  // Send Payment Info
  sendPaymentInfo = async (req, res) => {
    const reqObj = req.body && Object.keys(req.body).length ? req.body : paymentRequestData.sendPaymentInfo;
    return this.handlePaymentRequest("sendPaymentInfo", reqObj, res);
  };

  // Nav Services

  getNavMasterList = async (req, res) => {
    let reqObj = JSON.parse(JSON.stringify(navRequestData.getNavMasterList));
    let filterCode = null;

    if (req.body && Object.keys(req.body).length) {
      if (req.body.data) {
        reqObj = req.body;
      } else {
        const { start, length, nav_date, scheme_code, isin, scheme_isin, ...otherFilters } = req.body;

        filterCode = scheme_code || isin || scheme_isin;

        // Force fetch more records if filtering to ensure we find the fund
        if (filterCode) {
          reqObj.data.start = 0;
          reqObj.data.length = 20000;
          reqObj.data.search = { value: filterCode };
        } else {
          if (start !== undefined) reqObj.data.start = start;
          if (length !== undefined) reqObj.data.length = length;
        }

        if (nav_date) reqObj.data.filter_param.nav_date = nav_date;
        reqObj.data.filter_param = { ...reqObj.data.filter_param, ...otherFilters };
      }
    }

    try {
      if (!this.accessToken) await this.loginFunc();
      const response = await this.navService.getNavMasterList(this.accessToken, reqObj);

      if (filterCode && response?.data?.lists) {
        const searchCode = filterCode.toString().trim().toUpperCase();

        const filteredList = response.data.lists.filter(item => {
          const bseCode = (item.bse_scheme_code || "").toString().trim().toUpperCase();
          const rtaCode = (item.rta_scheme_code || "").toString().trim().toUpperCase();
          const isinCode = (item.isin || item.scheme_isin || "").toString().trim().toUpperCase();
          const schemeName = (item.scheme_name || "").toString().trim().toUpperCase();

          return bseCode === searchCode || rtaCode === searchCode || isinCode === searchCode || schemeName.includes(searchCode);
        });

        response.data.lists = filteredList;
        response.data.count = filteredList.length;
      }

      res.json(response);
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
  };

  getSchemeReturns = async (req, res) => {
    const { scheme_code, years = 3 } = req.body;

    if (!scheme_code) {
      return res.status(400).json({ error: "scheme_code is required" });
    }

    try {
      const today = new Date();
      const currentNavDate = this.formatBseDate(today);

      const currentNavResp = await this.fetchNavForScheme(scheme_code, currentNavDate);

      const oldDate = new Date();
      oldDate.setFullYear(today.getFullYear() - years);
      const oldNavDate = this.formatBseDate(oldDate);

      const oldNavResp = await this.fetchNavForScheme(scheme_code, oldNavDate);

      const currentNav = currentNavResp?.data?.[0]?.nav_value;
      const oldNav = oldNavResp?.data?.[0]?.nav_value;
      const schemeName = currentNavResp?.data?.[0]?.scheme_name;

      if (!currentNav || !oldNav) {
        return res.json({
          status: "partial_data",
          message: "NAV data not available for one of the dates. BSE historical data might be limited.",
          details: {
            current_nav: currentNav || "N/A",
            old_nav: oldNav || "N/A",
            current_date: currentNavDate,
            old_date: oldNavDate
          }
        });
      }

      const absoluteReturn = ((currentNav - oldNav) / oldNav) * 100;
      const cagr = (Math.pow(currentNav / oldNav, 1 / years) - 1) * 100;

      res.json({
        status: "success",
        scheme_name: schemeName,
        scheme_code: scheme_code,
        calculation_period: `${years} Years`,
        current_nav: currentNav,
        old_nav: oldNav,
        current_date: currentNavDate,
        old_date: oldNavDate,
        absolute_return: absoluteReturn.toFixed(2) + "%",
        annualized_return_cagr: cagr.toFixed(2) + "%"
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

  formatBseDate(date) {
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
  }

  // Helper: Convert Date object to BSE format "DD-MMM-YYYY" e.g. "05-May-2025"
  formatDate(date) {
    return date.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).replace(/ /g, '-');
  }

  async fetchNavsForDate(dateInput) {
    const callNavService = async (token, req) => {
      return await this.navService.getNavMasterList(token, req);
    };

    if (!this.accessToken) await this.loginFunc();

    // Accept both Date objects and formatted date strings
    let targetDate;
    if (dateInput instanceof Date) {
      targetDate = new Date(dateInput);
    } else {
      // Try to parse "DD-MMM-YYYY" format
      targetDate = new Date(dateInput.split('-').reverse().join('-'));
      if (isNaN(targetDate.getTime())) {
        targetDate = new Date(dateInput);
      }
    }

    for (let i = 0; i < 5; i++) {
      const formattedDate = this.formatDate(targetDate);
      const reqObj = {
        data: {
          fields: ["ALL"],
          start: 0,
          length: 20000,
          filter_param: { nav_date: formattedDate }
        }
      };
      
      let response;
      try {
        response = await callNavService(this.accessToken, reqObj);
      } catch (error) {
        const isUnauthorized = error.response?.status === 401 || 
                               error.message?.includes('401') || 
                               (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes("401 Authorization Required"));
        if (isUnauthorized) {
          console.log('[Token Expired] Received 401 in fetchNavsForDate. Refreshing token...');
          this.accessToken = null;
          await this.loginFunc();
          try {
            response = await callNavService(this.accessToken, reqObj);
          } catch (retryError) {
            console.error('Error in fetchNavsForDate after retry:', retryError);
            throw retryError;
          }
        } else {
          throw error;
        }
      }
      
      if (response?.data?.lists && response.data.lists.length > 0) return response;
      targetDate.setDate(targetDate.getDate() - 1);
    }
    return { data: { lists: [] } };
  }

  createNavMap(lists) {
    const map = {};
    lists.forEach(item => {
      if (item.isin) map[item.isin.toString().trim().toUpperCase()] = item;
      if (item.scheme_isin) map[item.scheme_isin.toString().trim().toUpperCase()] = item;
      if (item.bse_scheme_code) map[item.bse_scheme_code.toString().trim().toUpperCase()] = item;
      if (item.scheme_bse_code) map[item.scheme_bse_code.toString().trim().toUpperCase()] = item;
    });
    return map;
  }

  async fetchNavForScheme(scheme_code, date) {
    const response = await this.fetchNavsForDate(date);
    if (scheme_code && response?.data?.lists) {
      const searchCode = scheme_code.toString().trim().toUpperCase();
      const filtered = response.data.lists.filter(item => {
        const bseCode = (item.bse_scheme_code || "").toString().trim().toUpperCase();
        const rtaCode = (item.rta_scheme_code || "").toString().trim().toUpperCase();
        const isinCode = (item.isin || item.scheme_isin || "").toString().trim().toUpperCase();
        return bseCode === searchCode || rtaCode === searchCode || isinCode === searchCode;
      });
      response.data.lists = filtered;
    }
    return response;
  }
  async testAPI(req, res) {
    return res.json({
        msg: "API is working fine",
        // ponytail: deployed .env padhne ke liye — hostname bundle mein waise bhi public hai
        investorUrl: configData.investorUrl
    });
  }
  // Get payment link for an order function
  getPaymentLink = async (req, res) => {
    try {
      if (!req.body || !Object.keys(req.body).length) {
        return res.status(400).json({ status: "error", message: "Payment payload is required" });
      }
      const loginResp = await this.loginFunc();

      if (loginResp?.status === "error") {
        return res.json(loginResp);
      }

      const payload = bindUcc(req.body, req.ucc, this.memberCode);
      // ponytail: mem_details BSE ke liye lazmi hai aur member code server-side value hai —
      // frontend ko wo bhejne ki zaroorat nahi. Shape paymentRequestData.getExchPgService se.
      payload.data = payload.data || {};
      payload.data.mem_details = {
        member: this.memberCode,
        euin: "",
        euin_flag: false,
        sub_br_code: "",
        sub_br_arn: "",
        partner_id: "",
        ...(payload.data.mem_details || {}),
      };
      const response = await axios.post(
        `${this.bseDemoUrl}/get_exchpg_service`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      // ponytail: BSE ka link uske apne host par hai jahan user ka browser block hai.
      // Poore body par replace — link jis bhi key mein ho, proxy ke raaste par mud jaye.
      const rewritten = JSON.parse(this.proxify(JSON.stringify(response.data)));
      console.log("Payment link handed to UI:", rewritten?.data?.exch_pg_page_link || "(none)");
      return res.json({
        response: rewritten,
      });
    } catch (error) {
      console.error(
        "Payment Link Error:",
        error.response?.data || error.message
      );

      return res.status(500).json({
        status: "error",
        message: bseMessage(error),
        detail: error.response?.data || null,
      });
    }
  };

  // ponytail: page ke andar ke URL runtime par jurte hain (`base + "/api/x"`), is liye
  // poora `${baseUrl}/api/` string kabhi kabhi milta hi nahi — sirf host milta hai.
  // Host ko proxy prefix se badlo, baaki path jaisa ka waisa aage chala jata hai.
  proxify = (text) => String(text).split(this.baseUrl).join(PUBLIC_PG_PREFIX);

  // ponytail: sirf BSE host — suffix hamesha baseUrl ke peeche lagta hai, is liye koi
  // dusre host par nahi ja sakta (SSRF).
  proxyPaymentPage = async (req, res) => {
    const suffix = String(req.params[0] || "").replace(/^\/+/, "");
    if (!suffix) return res.status(400).send("Missing payment page path");
    const ctype = req.headers["content-type"] || "";
    const body = req.method === "POST" && req.body && Object.keys(req.body).length ? req.body : undefined;
    if (req.method === "POST" && !body) {
      // express.json() sirf JSON parse karta hai — form-encoded body yahan gum ho jayegi.
      console.warn(`Payment proxy: empty POST body for ${suffix} (content-type: ${ctype || "none"})`);
    }
    const fetchUpstream = (path) =>
      axios({
        method: req.method === "POST" ? "post" : "get",
        url: `${this.baseUrl}/${path}`,
        data: body,
        params: req.query,
        headers: {
          ...(ctype ? { "Content-Type": ctype } : {}),
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        },
        responseType: "arraybuffer",
        maxRedirects: 5,
        timeout: 30000,
        validateStatus: () => true,
        httpsAgent: this.insecureAgent,
      });
    try {
      let path = suffix;
      let upstream = await fetchUpstream(path);
      // ponytail: pehle prefix `/api` ko nigal jata tha, to purane link us ke baghair bane
      // hain. 404 par ek dafa `api/` laga kar dobara poocho — do try se zyada nahi.
      if (upstream.status === 404 && !suffix.startsWith("api/")) {
        path = `api/${suffix}`;
        upstream = await fetchUpstream(path);
      }
      if (upstream.status >= 400) {
        console.error(`Payment proxy: ${this.baseUrl}/${path} → ${upstream.status}`);
      }
      const type = upstream.headers["content-type"] || "application/octet-stream";
      res.status(upstream.status).set("content-type", type);
      // HTML, JS aur JSON — teeno mein BSE ke absolute link hote hain; sab ko mod do.
      if (!/text\/|json|javascript/i.test(type)) return res.send(Buffer.from(upstream.data));
      return res.send(this.proxify(Buffer.from(upstream.data).toString("utf8")));
    } catch (error) {
      console.error("Payment page proxy failed:", bseMessage(error));
      return res.status(502).send("Payment page unavailable");
    }
  };

  // mandate register upi autopay
  mandateRegisterUpiAutoPay = async (req, res) => {
    try {
      const loginResp = await this.loginFunc();

      if (loginResp?.status === "error") {
        return res.json(loginResp);
      }
      const response = await axios.post(
        `${this.bseDemoUrl}/mandate_register`,
        req.body,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      return res.json({
        response: response.data,
      });
    }catch (error) {
      console.error(
        "Mandate Register UPI Auto Pay Error:",
        error.response?.data || error.message
      );

      return res.status(500).json({
        status: "error",
        message: bseMessage(error),
        detail: error.response?.data || null,
      });
    }
  }
  getParticularUcc = async (req, res) => {
    try {
      const loginResp = await this.loginFunc();

      if (loginResp?.status === "error") {
        return res.json(loginResp);
      }
      const response = await axios.post(
        `${this.bseDemoUrl}/v2/get_ucc`,
        req.body,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      return res.json({
        response: response.data,
      });
    }catch (error) {
      console.error(
        "Ucc error",
        error.response?.data || error.message
      );

      return res.status(500).json({
        status: "error",
        message: bseMessage(error),
        detail: error.response?.data || null,
      });
    }
  };

  // BSE payment gateway callback — forwards status to Laravel admin backend
  paymentCallback = async (req, res) => {
    try {
      const secret = process.env.PAYMENT_WEBHOOK_SECRET;
      if (secret) {
        const provided =
          req.headers["x-webhook-secret"] ||
          req.body?.webhook_secret ||
          "";
        if (provided !== secret) {
          return res.status(401).json({ status: "error", message: "Unauthorized" });
        }
      }

      const payload = req.body;
      const webhookUrl = process.env.LARAVEL_WEBHOOK_URL;

      if (webhookUrl) {
        try {
          const headers = { "Content-Type": "application/json" };
          if (secret) headers["X-Webhook-Secret"] = secret;
          await axios.post(webhookUrl, payload, {
            headers,
            timeout: 10000,
          });
        } catch (fwdErr) {
          console.error("Laravel webhook forward failed:", fwdErr.message);
        }
      }

      return res.json({
        status: "success",
        message: "Payment callback received",
        data: payload,
      });
    } catch (error) {
      return res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  };
}

// Export an instance of the class
module.exports = new StarMFController();
module.exports.bseMessage = bseMessage;
module.exports.bseFailure = bseFailure;
