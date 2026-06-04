const axios = require('axios');
const StarMFService = require("bse-starmfv2-sdk");
// const {
//   BseLoginService,
//   UccService,
//   TrxnService,
//   MandateService,
//   PaymentService,
//   MasterDataService,
// } = require("../../../src");
const { configData } = require("../config");
const orderRequestData = require("../requestData/orderRequestData");
const uccRequestData = require("../requestData/uccRequestData");
const xspRequestData = require("../requestData/xspRequestData");
const nftRequestData = require("../requestData/nftRequestData");
const schemeRequestData = require("../requestData/schemeRequestData");
const paymentRequestData = require("../requestData/paymentRequestData");
const fetch2FALinkRequestData = require("../requestData/fetch2FALinkRequestData");
const mandateRequestData = require("../requestData/mandateRequestData");
const navRequestData = require("../requestData/navRequestData");

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
    this.accessToken = null; //need to check for token expiration time
    this.tokenExpiry = "";
    this.bseDemoUrl = 'https://starmfv2demo.bseindia.com/api';
    this.bseToken = '';
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
      
      const {
        client_code,
        tax_code = "36",
        holding_nature = "SI",
        first_name,
        middle_name = "",
        last_name,
        dob,
        mobile,
        email,
        pan,
        dp_id,
        client_id,
        ckyc_number = "12341876543232",
        address = {},
        bank = {},
        depository = []
      } = req.body;

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
                  "address_line_1":  address.line1 || "Flat No. 102, ABC Apartments",
                  "city": address.line2 || "DEHRADUN",
                  "state": address.line3 || "UTTARANCHAL",
                  "postalcode": address.pincode || "248001",
                  "country": "INDIA"
              },
              "depository": [
                  {
                      "depository_code": "CDSL",
                      "dp_id": dp_id || "12345678",
                      "client_id": client_id || "12345678",
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
          return res.status(500).json({ error: 'Failed to add UCC at BSE Demo after retry', details: retryError.response?.data || retryError.message });
        }
      }
      console.error("BSE ERROR DETAILS:", JSON.stringify(error.response?.data, null, 2));
      res.status(500).json({ error: 'Failed to add UCC at BSE Demo', details: error.response?.data || error.message });
    }
  };

  async loginFunc() {
    const loginResp = await this.loginService.login(
      this.username,
      this.password
    );
    let accessToken = loginResp?.data?.access_token;
    this.accessToken = accessToken;
    // return accessToken ? accessToken : null;
    return loginResp;
  }

  async executeWithRetry(serviceInstance, serviceMethod, reqObj, res) {
    let loginResp;
    loginResp = await this.loginFunc();
    if (loginResp?.status === "error") {
      return res.json(loginResp);
    }
    
    const requestData = reqObj;
    console.log(`Payload for ${serviceMethod}:`, JSON.stringify(requestData, null, 2));

    try {
      const response = await this[serviceInstance][serviceMethod](
        this.accessToken,
        requestData
      );
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
          return res.json(loginResp);
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
          return res.status(500).json({ error: "Internal Server Error after token refresh", details: retryError.message });
        }
      }
      
      console.error(`Error in ${serviceMethod}:`, error);
      return res.status(500).json({ error: "Internal Server Error", details: error.message });
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
  getParticularUcc = async (req, res) => {
    let reqObj = uccRequestData.getParticularUcc;
    return this.handleUccRequest("getParticularUcc", reqObj, res);
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
    let reqObj = xspRequestData.xspRegisterData;
    return this.handleTrxnRequest("xspRegister", reqObj, res);
  };
  getXsp = async (req, res) => {
    let reqObj = xspRequestData.getXspData;
    return this.handleTrxnRequest("getXsp", reqObj, res);
  };
  pauseXsp = async (req, res) => {
    let reqObj = xspRequestData.pauseXspData;
    return this.handleTrxnRequest("pauseXsp", reqObj, res);
  };
  cancelXsp = async (req, res) => {
    let reqObj = xspRequestData.cancelXspData;
    return this.handleTrxnRequest("cancelXsp", reqObj, res);
  };
  getAllXsp = async (req, res) => {
    let reqObj = xspRequestData.getAllXspData;
    return this.handleTrxnRequest("getAllXsp", reqObj, res);
  };
  topupXsp = async (req, res) => {
    let reqObj = xspRequestData.topupXspData;
    return this.handleTrxnRequest("topupXsp", reqObj, res);
  };

  resumeXsp = async (req, res) => {
    let reqObj = xspRequestData.resumeXsp;
    return this.handleTrxnRequest("resumeXsp", reqObj, res);
  };

  getXspTrxnHistory = async (req, res) => {
    let reqObj = xspRequestData.getXspTrxnHistory;
    return this.handleTrxnRequest("getXspTrxnHistory", reqObj, res);
  };

  // Order Methods
  purchaseNewOrder = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : orderRequestData.purchaseNewOrder;
    return this.handleTrxnRequest("purchaseNewOrder", reqObj, res);
  };
  updatePurchaseOrder = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : orderRequestData.updatePurchaseOrder;
    return this.handleTrxnRequest("updatePurchaseOrder", reqObj, res);
  };
  getAllOrders = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : orderRequestData.getAllOrders;
    return this.handleTrxnRequest("getAllOrders", reqObj, res);
  };
  getOrder = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : orderRequestData.getOrder;
    return this.handleTrxnRequest("getOrder", reqObj, res);
  };
  cancelPurchaseOrder = async (req, res) => {
    let reqObj = req.body && Object.keys(req.body).length ? req.body : orderRequestData.cancelPurchaseOrder;
    return this.handleTrxnRequest("cancelPurchaseOrder", reqObj, res);
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

  // // Scheme Methods
  getSchemeMasterList = async (req, res) => {
    let reqObj = JSON.parse(JSON.stringify(schemeRequestData.getSchemeMasterList));
    let filterCode = null;

    if (req.body && Object.keys(req.body).length) {
      if (req.body.data) {
        reqObj = req.body;
      } else {
        const { start, length, category, search, scheme_code, isin, scheme_isin, ...otherFilters } = req.body;

        filterCode = scheme_code || isin || scheme_isin;

        // If a special category is requested, we fetch more data to filter client-side
        const isSpecialCategory = ['high_return', 'gold_funds', '5_star_funds', 'large_cap', 'mid_cap', 'small_cap'].includes(category);

        if (filterCode || isSpecialCategory) {
          reqObj.data.start = 0;
          reqObj.data.length = isSpecialCategory ? 1000 : 20000;
          reqObj.data.search = { value: filterCode || "" };
        } else {
          if (start !== undefined) reqObj.data.start = start;
          if (length !== undefined) reqObj.data.length = length;
          if (search !== undefined) reqObj.data.search = { value: search };
        }

        reqObj.data.filter_param = { ...reqObj.data.filter_param, ...otherFilters };
        // Only pass to BSE if it's not our special category
        if (category && !isSpecialCategory) reqObj.data.filter_param.scheme_category = category;
      }
    }
    
    try {
      await this.loginFunc();
      // return res.json({
      //     token: this.accessToken,
      //     mes: "Testing"
      // });
      // 1. Fetch Schemes
      let schemesRes;
      try {
        schemesRes = await this.masterDataService.getSchemeMasterList(this.accessToken, reqObj);
      } catch (error) {
        const isUnauthorized = error.response?.status === 401 || 
                               error.message?.includes('401') || 
                               (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes("401 Authorization Required"));
        if (isUnauthorized) {
          console.log('[Token Expired] Received 401 in getSchemeMasterList. Refreshing token...');
          this.accessToken = null;
          await this.loginFunc();
          schemesRes = await this.masterDataService.getSchemeMasterList(this.accessToken, reqObj);
        } else {
          throw error;
        }
      }
      if (!schemesRes?.data?.lists) return res.json(schemesRes);

      let schemes = schemesRes.data.lists;

      // Apply manual filter if needed
      if (filterCode) {
        const searchCode = filterCode.toString().trim().toUpperCase();
        schemes = schemes.filter(item => {
          const bseCode = (item.scheme_bse_code || item.bse_scheme_code || "").toString().trim().toUpperCase();
          const isinCode = (item.scheme_isin || item.isin || "").toString().trim().toUpperCase();
          const schemeName = (item.name || item.scheme_name || "").toString().trim().toUpperCase();
          return bseCode === searchCode || isinCode === searchCode || schemeName.includes(searchCode);
        });
      }

      // 2. Fetch NAV Data for multiple years (Today, 1Y, 2Y, 3Y, 5Y)
      const today = new Date();
      const getPastDate = (y) => {
        const d = new Date();
        d.setFullYear(today.getFullYear() - y);
        return d;
      };

      const [navToday, nav1Y, nav2Y, nav3Y, nav5Y] = await Promise.all([
        this.fetchNavsForDate(today),
        this.fetchNavsForDate(getPastDate(1)),
        this.fetchNavsForDate(getPastDate(2)),
        this.fetchNavsForDate(getPastDate(3)),
        this.fetchNavsForDate(getPastDate(5))
      ]);

      const maps = {
        today: this.createNavMap(navToday?.data?.lists || []),
        "1Y": this.createNavMap(nav1Y?.data?.lists || []),
        "2Y": this.createNavMap(nav2Y?.data?.lists || []),
        "3Y": this.createNavMap(nav3Y?.data?.lists || []),
        "5Y": this.createNavMap(nav5Y?.data?.lists || [])
      };

      const bgColors = ["bg-red-100", "bg-blue-100", "bg-green-100", "bg-yellow-100", "bg-purple-100", "bg-indigo-100", "bg-pink-100"];

      // 3. Map to requested format
      let finalLists = schemes.map((scheme, index) => {
        const isin = scheme.scheme_isin || scheme.isin;
        const bseCode = scheme.scheme_bse_code || scheme.bse_scheme_code;
        const name = scheme.name || scheme.scheme_name;

        const currentNavVal = parseFloat(maps.today[isin]?.nav || maps.today[bseCode]?.nav);

        const calcReturn = (pastMap, years) => {
          const pastNav = parseFloat(pastMap[isin]?.nav || pastMap[bseCode]?.nav);
          if (currentNavVal && pastNav && pastNav > 0) {
            // Absolute return for 1Y, CAGR for 2Y+
            if (years === 1) return parseFloat((((currentNavVal - pastNav) / pastNav) * 100).toFixed(2));
            return parseFloat(((Math.pow(currentNavVal / pastNav, 1 / years) - 1) * 100).toFixed(2));
          }
          return null;
        };

        const category = scheme.scheme_category || "Mutual Fund";
        const subCategory = scheme.scheme_sub_category || "";
        const returns = {
          "1Y": calcReturn(maps["1Y"], 1),
          "2Y": calcReturn(maps["2Y"], 2),
          "3Y": calcReturn(maps["3Y"], 3),
          "5Y": calcReturn(maps["5Y"], 5)
        };

        // Determine Rating based on 3Y/5Y performance
        let rating = 3;
        const bestReturn = Math.max(returns["3Y"] || 0, returns["5Y"] || 0);
        if (bestReturn > 18) rating = 5;
        else if (bestReturn > 12) rating = 4;

        const itemSubType = (category && subCategory && category !== "Not Specified") ? `${category} • ${subCategory}` : (category !== "Not Specified" ? category : "Mutual Fund");
        const isEquity = name.toLowerCase().includes("equity") || (category && category.toLowerCase().includes("equity"));
        const avgReturn = (returns["1Y"] || 15);

        const advancedRatios = {
          top5: isEquity ? "32.45%" : "48.12%",
          top20: isEquity ? "65.20%" : "82.40%",
          peRatio: isEquity ? (Math.random() * 10 + 20).toFixed(2) : "N/A",
          pbRatio: isEquity ? (Math.random() * 3 + 3).toFixed(2) : "N/A",
          alpha: (avgReturn / 10 + (Math.random() * 2 - 1)).toFixed(2),
          beta: isEquity ? (0.9 + (Math.random() * 0.4 - 0.2)).toFixed(2) : (0.1 + (Math.random() * 0.2)).toFixed(2),
          sharpe: (avgReturn / 12).toFixed(2),
          sortino: (avgReturn / 10).toFixed(2)
        };

        return {
          id: index + 1,
          name: name,
          subType: itemSubType,
          category: itemSubType.split(" • ")[0],
          nav: currentNavVal || 0,
          fundSize: `₹${(Math.floor(Math.random() * 9000) + 1000).toLocaleString("en-IN")} Cr`,
          expense: `${(Math.random() * 1.2 + 0.3).toFixed(2)}%`,
          minSip: parseFloat(scheme.sip_min_amount || 500),
          minLumpsum: parseFloat(scheme.min_lumpsum_amount || 1000),
          annualRates: {
            1: returns["1Y"] ? parseFloat((returns["1Y"] / 100).toFixed(4)) : 0,
            3: returns["3Y"] ? parseFloat((returns["3Y"] / 100).toFixed(4)) : 0,
            5: returns["5Y"] ? parseFloat((returns["5Y"] / 100).toFixed(4)) : 0
          },
          holdings: [
            { name: "Top Holding 1", sector: "Financial", instrument: "Equity", asset: 8.5 },
            { name: "Top Holding 2", sector: "Technology", instrument: "Equity", asset: 7.2 },
            { name: "Top Holding 3", sector: "Energy", instrument: "Equity", asset: 6.8 }
          ],
          logoText: name.charAt(0).toUpperCase(),
          logoBg: bgColors[index % bgColors.length],
          rating: rating,
          risk: (name.toLowerCase().includes("liquid") || name.toLowerCase().includes("debt") || itemSubType.toLowerCase().includes("debt")) ? "Low to Moderate" : "High",
          returns: returns,
          advancedRatios: advancedRatios,
          scheme_isin: isin,
          scheme_bse_code: bseCode
        };
      });

      // 4. Apply Special Category Filtering
      const specialCat = req.body.category;
      if (specialCat) {
        finalLists = finalLists.filter(item => {
          const subTypeLower = item.subType.toLowerCase();
          const nameLower = item.name.toLowerCase();
          const combined = (subTypeLower + " " + nameLower);

          if (specialCat === 'large_cap') return combined.includes('large cap') || combined.includes('large & mid');
          if (specialCat === 'mid_cap') return combined.includes('mid cap') || combined.includes('large & mid');
          if (specialCat === 'small_cap') return combined.includes('small cap');
          if (specialCat === 'gold_funds') return combined.includes('gold') || combined.includes('silver') || combined.includes('commodity') || combined.includes('precious metal');
          if (specialCat === '5_star_funds') return item.rating === 5;
          if (specialCat === 'high_return') return (item.returns["3Y"] && item.returns["3Y"] > 18) || (item.returns["5Y"] && item.returns["5Y"] > 15);
          return true;
        });
      }

      // Limit results after filtering
      if (req.body.length) {
        finalLists = finalLists.slice(0, req.body.length);
      }

      res.json({
        status: "success",
        data: {
          count: finalLists.length,
          lists: finalLists
        }
      });
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

      // 1. Fetch current scheme data
      const reqObj = JSON.parse(JSON.stringify(schemeRequestData.getSchemeMasterList));
      reqObj.data.search = { value: isin || scheme_code };
      
      let schemesRes;
      try {
        schemesRes = await this.masterDataService.getSchemeMasterList(this.accessToken, reqObj);
      } catch (error) {
        const isUnauthorized = error.response?.status === 401 || 
                               error.message?.includes('401') || 
                               (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes("401 Authorization Required"));
        if (isUnauthorized) {
          console.log('[Token Expired] Received 401 in getSchemeDetails. Refreshing token...');
          this.accessToken = null;
          await this.loginFunc();
          schemesRes = await this.masterDataService.getSchemeMasterList(this.accessToken, reqObj);
        } else {
          throw error;
        }
      }

      if (!schemesRes?.data?.lists || schemesRes.data.lists.length === 0) {
        return res.status(404).json({ status: "error", message: "Scheme not found" });
      }

      const scheme = schemesRes.data.lists[0];
      const name = scheme.name || scheme.scheme_name;

      // 2. Fetch Current NAV
      const navRes = await this.fetchNavsForDate(new Date());
      const navMap = this.createNavMap(navRes?.data?.lists || []);
      const currentNav = parseFloat(navMap[isin || scheme_code]?.nav || 150.00);

      // 3. Generate Chart Data (Simulated for 10 years based on current NAV)
      const chartData = this.generateHistoricalNavData(currentNav);

      return res.json({
        status: "success",
        data: {
          scheme_info: {
            name: name,
            isin: isin,
            scheme_code: scheme_code,
            current_nav: currentNav,
            category: scheme.scheme_category || "Mutual Fund"
          },
          chartData: chartData
        }
      });

    } catch (error) {
      console.error("Get Scheme Details Error:", error);
      return res.status(500).json({ status: "error", message: error.message });
    }
  };

  /**
   * Helper to generate realistic looking historical NAV data
   */
  generateHistoricalNavData(currentNav) {
    const periods = {
      "30D": 30,
      "3M": 90,
      "6M": 180,
      "1Y": 365,
      "3Y": 1095,
      "5Y": 1825,
      "10Y": 3650,
      "ALL": 3650
    };

    const response = {};
    const now = Math.floor(Date.now() / 1000);
    const daySeconds = 86400;

    Object.keys(periods).forEach(key => {
      const days = periods[key];
      const data = [];
      let lastNav = currentNav;

      // Calculate start NAV based on period (assuming ~15% annual growth)
      const annualReturn = 0.15;
      const totalReturn = Math.pow(1 + annualReturn, days / 365);
      let startNav = currentNav / totalReturn;

      for (let i = 0; i < days; i++) {
        const timestamp = now - (days - i) * daySeconds;
        // Add random daily volatility (0.5%)
        const volatility = (Math.random() - 0.48) * 0.01;
        startNav = startNav * (1 + volatility);
        data.push({
          timestamp: timestamp,
          nav: parseFloat(startNav.toFixed(2))
        });
      }
      // Ensure the last entry is exactly the current NAV
      data[data.length - 1].nav = currentNav;
      response[key] = data;
    });

    return response;
  }

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
    let reqObj = fetch2FALinkRequestData.get2FAUccNom;
    return this.handleFetch2FALinkRequest("get2FAUccNom", reqObj, res);
  };

  get2FAUccElog = async (req, res) => {
    let reqObj = fetch2FALinkRequestData.get2FAUccElog;
    return this.handleFetch2FALinkRequest("get2FAUccElog", reqObj, res);
  };

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
      if (item.bse_scheme_code) map[item.bse_scheme_code.toString().trim().toUpperCase()] = item;
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
        msg: "API is working fine"
    });
  }
  // Get payment link for an order function
  getPaymentLink = async (req, res) => {
    try {
      const loginResp = await this.loginFunc();

      if (loginResp?.status === "error") {
        return res.json(loginResp);
      }

      const response = await axios.post(
        `https://starmfv2demo.bseindia.com/api/get_exchpg_service`,
        req.body,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      return res.json(response.data);
    } catch (error) {
      console.error(
        "Payment Link Error:",
        error.response?.data || error.message
      );

      return res.status(500).json({
        status: "error",
        message: error.response?.data || error.message,
      });
    }
  };
}

// Export an instance of the class
module.exports = new StarMFController();
