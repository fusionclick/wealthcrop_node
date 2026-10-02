const { configData, IS_BSE_DEMO, bseHttpsAgent } = require("../config");
const axios = require("axios");
const StarMFService = require("bse-starmfv2-sdk");
const { isTransactable, mapScheme, pickScheme, navLookup, calcReturns, buildChartSeries, fundProfile, ratiosFromSeries, parseListQuery, listCacheKey, getListCache, setListCache, schemeTransactions, returnsBoth, rollingReturns, alphaBeta, lockInFromYears, effectiveLockIn, minSources } = require("../mf/scheme");
// Dev only (Audit #1-#11 demo): inert unless MF_DEV_CATALOGUE_SNAPSHOT is set.
const { snapshotScheme } = require("../mf/devSnapshot");
const { getEnrichment, documentsUrl } = require("../mf/kuvera");
const { redemptionVerdict } = require("../mf/lockin");
const { benchmarkSeries, benchmarkFor, resolveBenchmark } = require("../mf/benchmark");
const { loadFundNav } = require("../mf/mfapi");
const { getNavs, navFor, navDateFor, navLooksPlausible } = require("../mf/navStore");
const { getCatalogue, schemeCategories, categoryRanking, AMFI_FALLBACK } = require("../mf/catalogue");
const { getHidden, isHidden } = require("../mf/hidden");
const { getAmfiNavs } = require("../mf/amfiNav");
const { bindUcc, validateOrder, checkSchemeLimits, twoFaUccPayload, normalizeOrder, investorUcc, investorMobile, normalizeMobile, BSE_PLACEHOLDER_MOBILE, switchRefusal, panVerified, PAN_NOT_VERIFIED, buildCancelOrderPayload } = require("../mf/order");
const { kycFromUcc, uccPan, investorPan } = require("../mf/kyc");
const { pdfLines, parseCas, casHoldings } = require("../mf/cas");
const { answer: qaAnswer, qaScheme } = require("../mf/qaFixtures");
const { MODES: MANDATE_MODES, validVpa, buildMandateRegisterPayload, mandateOutcome, recordMandate, storedMandates } = require("../mf/mandate");
const { splitByWeight, basketPlan } = require("../mf/basket");
const {
  buildXspRegisterPayload,
  validateSip,
  validateSxp,
  sxpTypeOf,
  xspRegNo,
  buildCancelXspPayload,
  buildPauseXspPayload,
  buildResumeXspPayload,
  buildTopupXspPayload,
  validateTopup,
  mergeSipChanges,
  netUnits,
  swpOverValue,
} = require("../mf/xsp");
const { checkSuitability, checkDisclaimers, DISCLAIMERS, REQUIRED_ACKS, LEGAL_ENTITY, DISTRIBUTOR_ARN } = require("../mf/suitability");

// AMFI compliance spec §1.B and §2. The version is what the consent log stores, so it is
// declared once here and travels with the text to the browser; bump it whenever the wording
// of anything in REQUIRED_ACKS changes, and never reuse a version.
const CONSENT_TEXT_VERSION = process.env.CONSENT_TEXT_VERSION || "2026.10";
const COMMISSION_VERSION = process.env.COMMISSION_STRUCTURE_VERSION || "2026.09";
// An empty URL renders no link rather than a dead one: a broken commission link is worse
// than a missing one, because it looks like disclosure and is not.
const COMMISSION_URL = String(process.env.COMMISSION_STRUCTURE_URL || "").trim();
const { memDetails, assertEuinSane } = require("../mf/euin");
const { recordConsents } = require("../mf/consent");
const { getDistributor, cachedDistributor } = require("../mf/distributor");
const { getRiskPolicy } = require("../mf/riskPolicy");
const { checkApproval } = require("../mf/approval");
const { getLimits, applyFloor } = require("../mf/platformLimits");
const { storedOrders, orderKey, statusChanges, reportStatusChanges, recordOrder } = require("../mf/storedOrders");
const { getHoldings } = require("../mf/holdings");
const { mapBseErrors } = require("../mf/bseFieldErrors");
const orderRequestData = require("../requestData/orderRequestData");
const nftRequestData = require("../requestData/nftRequestData");
const schemeRequestData = require("../requestData/schemeRequestData");
const paymentRequestData = require("../requestData/paymentRequestData");
const fetch2FALinkRequestData = require("../requestData/fetch2FALinkRequestData");
const navRequestData = require("../requestData/navRequestData");

// How many instalments sxp_trxn_history returns when the caller does not ask for a number.
// BSE treats `no_of_txn` as mandatory, so there is no "just give me all of them" — a value
// has to be chosen, and this is the Recent-payments panel's page size.
const XSP_HISTORY_ROWS = 50;

// 30s login timeout nginx ke proxy_read_timeout se lamba tha — BSE chup ho jaye to
// upstream ka jawab aane se pehle hi gateway 502 de deta tha. Asli login <2s leta hai.
const LOGIN_TIMEOUT_MS = Number(process.env.BSE_LOGIN_TIMEOUT_MS) || 10000;
const LOGIN_COOLDOWN_MS = Number(process.env.BSE_LOGIN_COOLDOWN_MS) || 30000;

// ponytail: BSE galtiyan `messages[]` mein bhejta hai — {msgid, errcode, field, vals}.
// `field` par order ka ref id prefix hota hai ("726215.depository_acct"), wo hata do.
// errcode jaise ka waisa dikhana ("Scheme is record_not_found") user ko kuch nahi batata.
const BSE_ERRCODES = {
  // Har field scheme nahi hoti — get_2fa_link par bhi yehi errcode aata hai.
  record_not_found: "was not found on BSE",
  required: "is required",
  invalid: "is invalid",
  not_allowed: "is not allowed",
  id_not_exist: "is not recognised by BSE",
};
// Kuch field aise hain jinka errcode bhi kuch nahi batata — inka poora jumla likha hai.
const BSE_FIELDS = {
  phys_ucc:
    "This scheme can only be held physically, but your BSE account is registered for demat only. Ask support to register it for both.",
};
/**
 * field + errcode together, where the code alone is misleading.
 *
 * `ucc / id_not_exist` reads as "no such UCC", and that is not what happened: get_ucc
 * returns the record perfectly well. BSE refuses the order because the UCC is still
 * PENDING_VERIFICATION — it exists but is not yet cleared to transact. Verified against
 * the live host: MIN2082973 answers PENDING_VERIFICATION on get_ucc and id_not_exist
 * (msgid 505) on order_new, while USRWC56442, which is ACTIVE, places orders fine.
 */
const BSE_FIELD_CODES = {
  "ucc:id_not_exist":
    "Your BSE account is not approved for transactions yet. BSE has registered your UCC but has not activated it, so orders cannot be placed until it does.",
};
const bseMessages = (r) =>
  (Array.isArray(r?.messages) ? r.messages : [])
    .map((m) => {
      if (m?.message || m?.msg) return String(m.message || m.msg);
      const field = String(m?.field || "field").split(".").pop();
      const pair = BSE_FIELD_CODES[`${field}:${String(m?.errcode || "")}`];
      if (pair) return pair;
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

const cell = (v) => String(v ?? "").trim();

/**
 * Which type, and is it live — decided here because BSE will not decide it for us:
 * `/sxp_list` rejects any `filter_param` key, `sxp_type` included (see buildXspListPayload).
 *
 * Fail-open on purpose. The demo book has no XSP rows, so the exact field names are
 * unconfirmed; a row is dropped only when a field we recognise is present AND clearly says
 * something else. An unknown shape stays visible — showing an STP by mistake is a cosmetic
 * bug, hiding somebody's real SIP is not. Confirm the field names against a prod account
 * with live SIPs and this can tighten.
 *
 * @param want  "sip" | "swp" | "stp", or null for every type. Tickets 17 and 18 gave SWP
 *   and STP their own pages, and each wants only its own rows — but they arrive from the
 *   same /sxp_list call, so the narrowing has to happen here.
 */
const isActiveSxp = (item, want = "sip", { cancelled = false } = {}) => {
  const type = cell(item?.sxp_type || item?.xsp_type || item?.type);
  // STP rows come back as STP-IN / STP-OUT, so match the prefix rather than the whole word.
  if (want && type && !new RegExp(`^${want}\\b|^${want}-`, "i").test(type)) return false;
  const status = cell(item?.status || item?.sxp_status || item?.xsp_status);
  // Audit #20 — a cancelled registration is history the investor can ask to see (Manage
  // SIPs' Cancelled tab); dropping it here is why that tab was always empty after a refresh.
  if (cancelled && /cancel/i.test(status)) return true;
  if (status && /cancel|close|expire|reject|fail|stop/i.test(status)) return false;
  return true;
};

// BSE's SIP-list filters do not accept UCC/member. Search narrows the gateway
// result, and this final server-side check prevents another investor's row from
// ever reaching the browser.
/**
 * @param activeOnly  the SIPs *page* wants only live SIPs, but an ownership check wants
 *   every row this UCC owns — otherwise cancelling an already-cancelled SIP answers "no
 *   such SIP on this account", which is both untrue and unhelpful. Scoping by UCC is the
 *   security half and is never optional; the SIP-vs-STP / live-vs-dead filter is the
 *   cosmetic half and is what this turns off.
 * @param type  which sxp_type to keep; null keeps every type.
 */
const scopeXspResponse = (response, ucc, { activeOnly = true, type = "sip", cancelled = false } = {}) => {
  const data = response?.data;
  if (!data || typeof data !== "object") return response;
  const key = Array.isArray(data.lists) ? "lists" : Array.isArray(data.items) ? "items" : null;
  if (!key) return response;
  const expected = cell(ucc);
  const rows = data[key].filter(
    (item) =>
      [item?.ucc, item?.ucc_code, item?.client_code, item?.investor_ucc, item?.investor?.ucc, item?.investor?.client_code]
        .some((value) => cell(value) === expected) && (!activeOnly || isActiveSxp(item, type, { cancelled }))
  );
  // total_count is BSE's pre-filter number; leaving it would overstate what we returned.
  return { ...response, data: { ...data, [key]: rows, count: rows.length, total_count: rows.length } };
};

/**
 * getAllXsp (sxp_list) ka payload.
 *
 * Sirf wahi keys jo is codebase ki kisi *chalti hui* BSE call mein maujood hain —
 * `src/mf/catalogue.js` ka master-scheme-list production mein roz chalta hai aur
 * bilkul yehi shape bhejta hai: start, length, fields, count_only, filter_param, search.
 *
 * Hataye gaye: format:"", sort_by:"", sort_dir:"", is_compressed:false aur
 * filter_param.freq:"". Ye chaar kisi kaam karti call mein kabhi nahi thay; BSE poori
 * request ko `field is invalid_json` keh kar reject karta tha aur executeWithRetry usay
 * 502 bana deta tha — SIPs page hamesha khali. Khali string BSE ke liye valid enum
 * nahi hai (sibling getClientPortfolio par bhi yehi kahani likhi hai: galat shakl ka
 * filter = invalid_json).
 *
 * Us note ne agla shak `search` par daala tha. Wo shak GALAT tha. Live BSE (demo host,
 * whitelisted box) par har variant chala kar dekha gaya:
 *
 *   filter_param {sxp_type,status} + search{value}   -> invalid_json
 *   filter_param {sxp_type,status} + search{}        -> invalid_json
 *   filter_param {sxp_type,status}, koi search nahi  -> invalid_json
 *   filter_param {ucc:[..],member_code}              -> invalid_json
 *   filter_param {}                + search{}        -> success
 *   filter_param {}                + search{value}   -> success
 *   filter_param {}                + search:"UCC"    -> invalid_json  (string nahi, object)
 *
 * Yaani `/sxp_list` `filter_param` mein KOI key nahi leta — sxp_type, status, ucc,
 * member_code, sab reject. Isi liye har SIPs page load 502 deta tha. (Sibling
 * getClientPortfolio ucc/member_code leta hai; wo endpoint alag hai, uska shape yahan
 * apply nahi hota — wo bhi test kiya aur reject hua.)
 *
 * `search: {value: ucc}` object ke tor par valid hai aur gateway par narrow karta hai, is
 * liye paging ke liye rakha hai. Asli hifazat `scopeXspResponse` hai — narrowing fail bhi
 * ho jaye to doosre client ki row browser tak nahi jati. sxp_type/status ki chhanti ab
 * wahin locally hoti hai, kyunki BSE se maangi hi nahi ja sakti.
 */
const buildXspListPayload = (input, ucc) => ({
  data: {
    // Clamp dono taraf — `-5` truthy hai, is liye `|| 50` usay nahi pakarta aur
    // BSE ko manfi length chali jati hai.
    start: Math.max(Number(input?.start) || 0, 0),
    length: Math.min(Math.max(Number(input?.length) || 50, 1), 100),
    fields: ["ALL"],
    count_only: false,
    filter_param: {},
    search: { value: String(ucc || "") },
  },
});

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
    this.loginInflight = null;
    this.loginDownUntil = 0;
    this.tokenExpiry = "";
    // ponytail: follow BSE_BASE_URL (demo|prod) — was hardcoded demo while .env used prod
    this.bseDemoUrl = `${String(configData.baseUrl).replace(/\/$/, "")}/api`;
    this.bseToken = "";
    this.httpsAgent = bseHttpsAgent;
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
      ax.defaults.httpsAgent = this.httpsAgent;
      ax.interceptors.request.use((config) => {
        config.httpsAgent = this.httpsAgent;
        return config;
      });
      // ponytail: BSE ka token chup-chaap expire hota hai. Gateway 401 "Authorization
      // Required" ka HTML deta hai aur SDK usay throw karne ke bajaye return kar deta
      // hai (MasterDataService ka catch errorParser(error).data lauta deta hai), is liye
      // executeWithRetry ki catch-wali retry kabhi chalti hi nahi thi — token container
      // restart tak mara rehta tha aur har BSE call 502/khali list deti thi. Ye
      // interceptor SDK ke catch se pehle chalta hai: 401 par ek naya token le kar wahi
      // request ek dafa dobara. Ceiling: ek hi retry, aur sirf in SDK services par —
      // raw axios calls (2FA/payment) apna login khud karte hain.
      ax.interceptors.response.use(undefined, async (error) => {
        const cfg = error?.config;
        if (error?.response?.status !== 401 || !cfg || cfg.__bseRetried) throw error;
        cfg.__bseRetried = true;
        const login = await this.refreshToken();
        if (login?.status === "error") throw error;
        console.log("[BSE] token expired — refreshed, retrying", cfg.url);
        // ponytail: AxiosHeaders ko spread karne se purana `authorization` bhi saath aa
        // jata hai aur kaun jeeta ye tay nahi — is liye set() use karte hain jab mile.
        const bearer = `Bearer ${this.accessToken}`;
        if (cfg.headers && typeof cfg.headers.set === "function") cfg.headers.set("Authorization", bearer);
        else cfg.headers = { ...(cfg.headers || {}), Authorization: bearer };
        cfg.httpsAgent = this.httpsAgent;
        return ax.request(cfg);
      });
    });
  }

  /**
   * Naya token, ek waqt mein sirf ek login. Parallel 401s warna kai logins bhejte hain
   * aur BSE purane session ko invalid kar deta hai — phir sab kuch dobara 401 ho jata.
   */
  refreshToken() {
    this.accessToken = null;
    return this.loginFunc();
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

    // PAN is optional on the KYC form (an investor can save a partial profile and come
    // back), so a request with no PAN now genuinely reaches this handler. It used to be
    // spread through the body as `pan || "NYTPA0008A"` in three places — a hardcoded PAN
    // that is not the investor's, registered at BSE against their real name, bank and
    // address. Same class of bug as the "123456789012" bank fallback: refuse, never invent.
    const holderPan = String(pan || "").trim().toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(holderPan)) {
      return res.status(400).json({
        error: 'Validation failed',
        field: 'person.pan',
        message: 'PAN is required and must look like ABCDE1234F'
      });
    }
    // 4th character is the holder type, and this payload is hardcoded Individual/SI.
    if (holderPan[3] !== 'P') {
      return res.status(400).json({
        error: 'Validation failed',
        field: 'person.pan',
        message: 'Only an individual PAN (4th letter P) can be registered here'
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
                      // ponytail: "M" hi theek hai — isi par order 5001433387 laga tha.
                      // UCC dobara submit karne se verification pending ho jati hai aur
                      // BSE ka RTA batch use khud verify karta hai; auth_mode ka us se
                      // koi taalluq nahi. Bila zaroorat mat chherna.
                      "auth_mode": "M",
                      "is_pan_exempt": false,
                      "pan_exempt_category": "",
                      "identifier": [
                          {
                              "identifier_type": "pan",
                              "identifier_number": holderPan
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
                              "contact_number": normalizeMobile(mobile) || BSE_PLACEHOLDER_MOBILE,
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
                          "identifier_number": holderPan
                      },
                      "wealth_source": "1",
                      "income_slab": "32",
                      "politically_exposed": "N",
                      "is_self_declared": true,
                      "data_source": "P",
                      "tax_residency": [
                          {
                              "country": "IND",
                              "tax_id_no": holderPan,
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

      // add_ucc's own reply does not reliably carry the UCC's status, and the KYC page was
      // left waiting on Laravel's separate bse-status sync — which, when it fails, leaves
      // the investor on "awaiting BSE verification" with no way forward. Ask BSE directly
      // for the record we just created and hand the verdict back with the response, so the
      // page can decide without a second hop through Laravel.
      let kyc = null;
      try {
        if (!this.accessToken) await this.loginFunc();
        const rec = await this.uccService.getParticularUcc(this.accessToken, {
          data: { investor: { client_code } },
        });
        const record = rec?.data?.lists?.[0] || rec?.data || null;
        if (record?.ucc_status) kyc = kycFromUcc(record, client_code, IS_BSE_DEMO);
      } catch (e) {
        // Never fail a successful registration because the follow-up lookup did not answer.
        console.warn("[kyc] post-add_ucc status lookup failed:", e.message);
      }
      if (kyc?.auto_verified_on_demo) {
        console.warn("[kyc] UAT host — PENDING_VERIFICATION treated as verified", { ucc: client_code });
      }

      res.json(kyc ? { ...responseData, kyc } : responseData);
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
            // Same mapper as the non-retry path below — this branch had its own slightly
            // different copy of the table, which is how the two drifted apart.
            return res.status(400).json({ error: 'BSE validation failed', errors: mapBseErrors(retryBseMessages), raw: retryBseMessages });
          }
          return res.status(500).json({ error: 'Failed to add UCC at BSE Demo after retry', details: retryError.response?.data || retryError.message });
        }
      }
      console.error("BSE ERROR DETAILS:", JSON.stringify(error.response?.data, null, 2));

      // T1.9 — Map BSE error codes to user-friendly messages. See src/mf/bseFieldErrors.js:
      // keyed by errcode as well as msgid (alpha_special arrives as msgid 0), and it falls
      // back to BSE's own explanation in vals[0] rather than printing the raw code.
      const bseMessages = error.response?.data?.messages || [];
      if (bseMessages.length > 0) {
        return res.status(400).json({ error: 'BSE validation failed', errors: mapBseErrors(bseMessages), raw: bseMessages });
      }

      res.status(500).json({ error: 'Failed to add UCC at BSE Demo', details: error.response?.data || error.message });
    }
  };

  /**
   * 14 call sites `if (!this.accessToken) await this.loginFunc()` karte hain. BSE down ho
   * to har request apna poora timeout jalati thi — ek page load ke do parallel calls = do
   * 21s waits, aur nginx ke saamne 502. Teen guard yahin, shared jagah par:
   *   1. token maujood hai   -> koi round trip nahi
   *   2. login chal raha hai -> ussi ka intezar (parallel logins BSE session invalid karte hain)
   *   3. abhi fail hua       -> COOLDOWN tak seedha error, BSE ko dobara nahi chhedte
   *
   * ponytail: cooldown 30s — ek page load ka burst nigal jata hai, phir bhi user ka retry
   * asli koshish karta hai. Order paths ko wahi `{status:"error"}` milta hai jo fail login
   * par pehle bhi milta tha, bas 21s ke bajaye foran. Cooldown chhota/bara karna ho to
   * BSE_LOGIN_COOLDOWN_MS.
   */
  async loginFunc() {
    if (!this.username || !this.password) {
      return { status: "error", message: "BSE credentials not configured" };
    }
    if (this.accessToken) return { status: "success", data: { access_token: this.accessToken } };
    if (this.loginInflight) return this.loginInflight;
    if (Date.now() < this.loginDownUntil) {
      return { status: "error", message: this.loginDownMessage || "BSE login unavailable" };
    }
    this.loginInflight = this.bseLogin().finally(() => {
      this.loginInflight = null;
    });
    return this.loginInflight;
  }

  async bseLogin() {
    try {
      const response = await axios.post(
        `${this.bseDemoUrl}/login`,
        { data: { username: this.username, password: this.password } },
        { httpsAgent: this.httpsAgent, timeout: LOGIN_TIMEOUT_MS }
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
        return this.markLoginDown(data?.message || "BSE login returned no token", data);
      }
      this.loginDownUntil = 0;
      return data.status ? data : { status: "success", data: { access_token: this.accessToken } };
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.message ||
        error.code ||
        "BSE login failed";
      console.error("BSE login failed:", message);
      return this.markLoginDown(message, error.response?.data || null);
    }
  }

  markLoginDown(message, detail = null) {
    this.loginDownUntil = Date.now() + LOGIN_COOLDOWN_MS;
    this.loginDownMessage = String(message);
    return { status: "error", message: String(message), detail };
  }

  async executeWithRetry(serviceInstance, serviceMethod, reqObj, res, transform = (response) => response) {
    // ponytail: pehle har request par ek naya login hota tha — extra round trip aur BSE
    // par session churn (naya token purane ko mar deta hai, jis se doosri in-flight
    // request 401 khaati thi). Expiry ab response interceptor sambhalta hai, is liye
    // login sirf tab jab token hai hi nahi.
    let loginResp = this.accessToken ? { status: "success" } : await this.loginFunc();
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
      return res.json(transform(response));
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
          return res.json(transform(response));
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

  async handleTrxnRequest(serviceMethod, reqObj, res, transform) {
    // Every BSE trxn call funnels through here, so one check covers order_list, sxp_list
    // and the registration mutations rather than seven separate ones. Returns null unless
    // MF_QA_UCC lists this exact client code, in which case nothing below changes.
    const canned = qaAnswer(serviceMethod, reqObj);
    if (canned) return res.json(transform ? transform(canned) : canned);
    return this.executeWithRetry("trxnService", serviceMethod, reqObj, res, transform);
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

  // ── Mandates (Audit #22) ──────────────────────────────────────────────────────────────
  // Every one of these used to send requestData's DEMO payload — someone else's UCC, mandate
  // id 20, reg_no "reg-12345-xyz" — whatever the investor asked. They now act only on the
  // caller's own mandates (Laravel's `mandates` rows, filed under their bearer) and SIPs.

  /** A mandate call's body, QA book first — the same rule handleTrxnRequest applies. */
  callMandate(serviceMethod, reqObj) {
    const canned = qaAnswer(serviceMethod, reqObj);
    if (canned) {
      const failure = bseFailure(canned);
      return Promise.resolve(failure ? { status: "error", message: failure, _status: 502 } : canned);
    }
    return new Promise((resolve) => {
      this.executeWithRetry("mandatteService", serviceMethod, reqObj, {
        json: (data) => resolve(data),
        status: (code) => ({ json: (data) => resolve({ ...data, _status: code }) }),
      });
    });
  }

  /** The caller's mandate by BSE id, from their own rows — or null. */
  async ownedMandate(req, id) {
    const want = String(id ?? "").trim();
    if (!want) return null;
    return (await storedMandates(req)).find((m) => String(m.exch_mandate_id) === want) || null;
  }

  // The three register routes now share one server-built registration; the route only says
  // which channel to assume when the body names none.
  registerMandate = (req, res) => this.mandateRegisterUpiAutoPay(req, res);
  registerMandateUPI = (req, res) => this.mandateRegisterUpiAutoPay(req, res, "upi");
  registerMandateEnach = (req, res) => this.mandateRegisterUpiAutoPay(req, res, "netbanking");

  // A physical NACH form is a scanned, signed paper mandate (`nach_scan_img` in the template).
  // Nothing in this product captures one, so these refuse plainly instead of sending a demo image.
  registerMandateNach = (_req, res) =>
    res.status(501).json({ status: "error", message: "Paper NACH forms are not supported here. Use UPI AutoPay or an e-mandate." });
  updateMandate = (_req, res) =>
    res.status(501).json({ status: "error", message: "Updating a mandate needs a scanned NACH form, which is not supported here." });

  getMandate = async (req, res) => {
    const mine = await this.ownedMandate(req, (req.body?.data || req.body || {}).exch_mandate_id);
    if (!mine) return res.status(404).json({ status: "error", message: "No such mandate on this account." });
    const result = await this.callMandate("getMandate", { data: { exch_mandate_id: Number(mine.exch_mandate_id) } });
    if (result?._status) return res.status(result._status).json({ status: "error", message: result.message });
    return res.json(result);
  };

  // The investor's mandates with BSE's current status — the same answer as /mandateStatus.
  // BSE's own mandate_list is not asked: which filter keys it accepts is unproven, and the
  // sibling sxp_list rejects every one (see buildXspListPayload).
  getAllMandate = (req, res) => this.mandateStatus(req, res);

  cancelMandate = async (req, res) => {
    const mine = await this.ownedMandate(req, (req.body?.data || req.body || {}).exch_mandate_id);
    if (!mine) return res.status(404).json({ status: "error", message: "No such mandate on this account." });
    const result = await this.callMandate("cancelMandate", {
      data: { ids: [Number(mine.exch_mandate_id)], investor: { ucc: req.ucc } },
    });
    if (result?._status) return res.status(result._status).json({ status: "error", message: result.message });
    await recordMandate(req, { exch_mandate_id: mine.exch_mandate_id, mode: mine.mode, status: "cancelled", amount: mine.amount });
    return res.json({ status: "success", message: "Mandate cancelled." });
  };

  linkMandate = async (req, res) => {
    const input = req.body?.data || req.body || {};
    const mine = await this.ownedMandate(req, input.exch_mandate_id);
    const sip = mine && (await this.loadOwnedSip(req, input.reg_no));
    if (!mine || !sip) return res.status(404).json({ status: "error", message: "No such mandate or SIP on this account." });
    const linked = await this.linkMandateToSip(req, mine, xspRegNo(sip));
    if (!linked) return res.status(502).json({ status: "error", message: "BSE did not link the mandate to this SIP." });
    return res.json({ status: "success", message: "Mandate linked to the SIP." });
  };

  mandateDelink = async (req, res) => {
    const sip = await this.loadOwnedSip(req, (req.body?.data || req.body || {}).reg_no);
    if (!sip) return res.status(404).json({ status: "error", message: "No such SIP on this account." });
    const result = await this.callMandate("mandateDelink", { data: { reg_nos: [xspRegNo(sip)] } });
    if (result?._status) return res.status(result._status).json({ status: "error", message: result.message });
    return res.json({ status: "success", message: "Mandate unlinked from the SIP." });
  };

  /** BSE link_mandate for one of the caller's SIPs, recorded in Laravel when BSE agrees. */
  async linkMandateToSip(req, mandate, regNo) {
    const result = await this.callMandate("linkMandate", {
      data: { reg_no: String(regNo), exch_mandate_id: Number(mandate.exch_mandate_id) },
    });
    if (result?._status) return false;
    await recordMandate(req, {
      exch_mandate_id: mandate.exch_mandate_id,
      mode: mandate.mode,
      status: mandate.status,
      amount: mandate.amount,
      sip_reg_no: String(regNo),
      linked: true,
    });
    return true;
  }

  /**
   * The investor's mandates, each with BSE's current word on it.
   *
   * No cron: a pending mandate is re-read from BSE when the investor looks (Manage SIPs), and
   * a change is filed back to Laravel, which tells the investor once. A mandate whose SIP was
   * not yet visible to BSE when it was registered is linked here, on a later look.
   */
  mandateStatus = async (req, res) => {
    const out = [];
    for (const m of await storedMandates(req)) {
      let row = m;
      if (m.exch_mandate_id && m.status === "pending") {
        const result = await this.callMandate("getMandate", { data: { exch_mandate_id: Number(m.exch_mandate_id) } });
        const state = result?._status ? null : mandateOutcome(result).state;
        if (state && state !== m.status) {
          row = (await recordMandate(req, { exch_mandate_id: m.exch_mandate_id, mode: m.mode, status: state, amount: m.amount })) || { ...m, status: state };
        }
      }
      if (row.exch_mandate_id && row.sip_reg_no && !row.linked && !["cancelled", "rejected"].includes(row.status)) {
        const sip = await this.loadOwnedSip(req, row.sip_reg_no);
        if (sip && (await this.linkMandateToSip(req, row, xspRegNo(sip)))) row = { ...row, linked: true };
      }
      out.push(row);
    }
    return res.json({ status: "success", data: { mandates: out } });
  };

  /**
   * The two pre-order gates every order path shares (tickets 22, 24).
   *
   * Returns the refusal body, or null to let the order through. One function because
   * /purchaseNewOrder, /xspRegister and /modifyXsp are three doors into the same room —
   * gating one of them is the same as gating none.
   *
   * The two gates have different reach, and conflating them is what left a SWP with no
   * disclaimer at all. SUITABILITY is buy-only: refusing a sell would trap an investor in a
   * fund their profile no longer permits. A SWP is not a buy, but ticket 22 names it, and
   * registering one is a considered act rather than an exit — so it takes the disclaimer
   * gate alone, via `suitability:false`. A one-off redemption takes neither (see
   * purchaseNewOrder): it is the exit, and the disclaimer gate fails closed.
   */
  async gateOrder(req, rawScheme, { suitability = true, approval = null } = {}) {
    // Audit #33 — the RM register is read from the same cache the ARN in every payload comes
    // from (the checkout's own /disclaimers call keeps it warm); a cold cache is an empty
    // register, so an RM-assisted order fails closed rather than trusting an unknown EUIN.
    const disclaimed = checkDisclaimers(req.body?.data || req.body || {}, { rms: cachedDistributor().rms });
    if (!disclaimed.ok) {
      return { status: "error", code: disclaimed.code, message: disclaimed.message, required: disclaimed.required };
    }
    // Only ever set from the register-checked declaration; purchaseNewOrder and logConsents
    // read it so BSE and the audit trail name the same employee.
    req.rmEuin = disclaimed.euin || "";
    // lookupScheme hands back BSE's raw master row, which carries a category but no SEBI
    // riskometer level — BSE's master has no such column. Map it, then ask the enrichment
    // source for the level, exactly as the fund page does. Fail-open there means the
    // category rules carry the check on their own, which is the documented behaviour.
    let scheme = {};
    if (rawScheme) {
      const mapped = mapScheme(rawScheme);
      let risk = mapped.risk || null;
      if (!risk) {
        try {
          risk = (await getEnrichment(mapped.scheme_bse_code))?.risk || null;
        } catch (e) {
          console.warn("[gate] risk level unavailable:", e.message);
        }
      }
      scheme = { ...mapped, risk };
    }
    // Ticket 23 — the ceilings come from the admin panel. Awaited here, at the one place
    // every order path already funnels through, so a compliance change takes effect within
    // the cache TTL and no caller has to remember to load it.
    const suitable = suitability ? checkSuitability(req.investor, scheme, await getRiskPolicy()) : { ok: true };
    if (!suitable.ok) {
      return { status: "error", code: suitable.code, message: suitable.message };
    }
    // SRS §4 — a transaction at or above the configured amount is held for authorisation.
    // It belongs in this gate, not on Laravel's order row: that row is written after BSE
    // already has the order, so nothing reading it could stop one. Skipped entirely when
    // the caller passes no intent, and costs nothing when the threshold is 0 (the default).
    // Audit #49 — asked only once every other gate has passed: an approval is spent the
    // moment it is checked, so asking first spent "Place now" clearances (and queued admin
    // requests) on orders suitability was about to refuse anyway. Only buys are ever held.
    // Persist before consuming a one-use approval or contacting the exchange.
    const body = req.body?.data || req.body || {};
    req.consentRef = String(body.mem_ord_ref_id || body.orders?.[0]?.mem_ord_ref_id || body.mem_sxp_ref_id || require("crypto").randomBytes(8).toString("hex").toUpperCase());
    if (!(await this.logConsents(req, approval, scheme))) {
      return { status: "error", code: "consent_unavailable", httpStatus: 503,
        message: "Your consent could not be saved. Nothing has been submitted; please try again." };
    }
    if (approval) {
      const held = await checkApproval(req, approval);
      if (held) return held;
    }
    return null;
  }

  /**
   * §2 — persist the authorised instruction before exchange submission and approval use.
   *
   * The EUIN pair comes from the same memDetails() used by order_new. SXP/mandate APIs
   * have no verified declaration field; their authorised instruction is retained locally.
   */
  async logConsents(req, approval, scheme) {
    const body = req.body?.data || req.body || {};
    // The same reference is passed into the order/SXP payload builder.
    const orderId =
      String(req.consentRef || "").slice(0, 64) || null;
    const schemeCode = String(approval?.scheme_code || scheme?.scheme_bse_code || body.scheme || body.src_scheme || "").trim();
    const sent = memDetails({ euin: req.rmEuin });

    return recordConsents(req, [
      {
        // §2 rows 1/2 — whichever declaration the order actually carries to BSE.
        type: sent.euin ? "rm_assisted" : "execution_only",
        order_id: orderId,
        euin_number: sent.euin || null,
        euin_declared: sent.euin_flag === true,
      },
      // The table the investor was shown — null while no AMC-wise rates are published,
      // rather than a version number nothing stands behind.
      { type: "regular_plan_commission", order_id: orderId, commission_version: cachedDistributor().commission_version || null },
      { type: "scheme_documents", order_id: orderId, scheme_codes: schemeCode ? [schemeCode] : [] },
    ]);
  }

  /**
   * The disclaimer text the checkout screens render, which of them must be ticked, and the
   * AMFI identity block every page has to carry.
   *
   * Served from one place so legal changes wording once. `consent_text_version` travels with
   * it because the eight-year audit trail records the version an investor agreed to, and the
   * two must come from the same response or they can drift.
   */
  disclaimers = async (_req, res) => {
    // Identity and the commission link come from the admin panel, so the ARN can be
    // corrected without a deploy and is the same value the order payload carries.
    const dist = await getDistributor();
    // The scheme_documents / regular_plan wording names the legal entity, so it has to track
    // whatever the panel says rather than the env value this process booted with.
    const disclaimers = { ...DISCLAIMERS };
    if (dist.legal_entity && dist.legal_entity !== LEGAL_ENTITY) {
      for (const key of ["execution_only", "rm_assisted"]) {
        disclaimers[key] = DISCLAIMERS[key].split(LEGAL_ENTITY).join(dist.legal_entity);
      }
    }
    return res.json({
      status: "success",
      data: {
        disclaimers,
        required: REQUIRED_ACKS,
        consent_text_version: CONSENT_TEXT_VERSION,
        // §1.A.1 — the mandatory branding line. Sent rather than hardcoded in the bundle so
        // an ARN change does not need a frontend deploy, and so one wrong value cannot be
        // right on one screen and stale on another. A blank `line` means "not configured",
        // and the frontend then renders nothing rather than "ARN: ".
        distributor: {
          legal_entity: dist.legal_entity,
          arn: dist.arn,
          line: dist.line,
        },
        // §1.B — the commission structure must be a FUNCTIONAL hyperlink at checkout.
        // Audit #32 — the page is always linked (it says plainly when rates are not yet
        // published); `commission_published` tells the checkout which of the two it is.
        commission_url: dist.commission_url || COMMISSION_URL,
        commission_structure_version: dist.commission_version || COMMISSION_VERSION,
        commission_published: Boolean(dist.commission_version),
        // Audit #33 — the RM register the checkout offers as "assisted by" (EUIN + name).
        rms: dist.rms || [],
      },
    });
  };

  /**
   * Ticket 16 — read a CAMS/KFintech CAS and return the holdings in it.
   *
   * Read-only by design: the parsed rows go back to the browser, which saves the ones the
   * investor ticks through the external-portfolio endpoint it already uses. So an import
   * that half-works leaves nothing behind to clean up, and a re-import is free.
   */
  casImport = async (req, res) => {
    const body = req.body || {};
    // Accepts a bare base64 string or a FileReader data URL, since the browser produces
    // the latter and stripping it there would be one more thing to get wrong.
    const base64 = String(body.file || body.pdf || "").replace(/^data:[^;]*;base64,/, "");
    if (!base64) {
      return res.status(400).json({ status: "error", message: "Attach your CAS PDF." });
    }
    const pdf = Buffer.from(base64, "base64");
    // %PDF- is the file's own magic number — a renamed .jpg is caught here rather than
    // inside pdfjs, and an empty or garbled base64 never reaches the parser at all.
    if (pdf.length < 1000 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return res.status(400).json({ status: "error", message: "That file is not a PDF." });
    }

    let parsed;
    try {
      parsed = parseCas(await pdfLines(pdf, body.password));
    } catch (e) {
      if (e.code === "cas_password" || e.code === "cas_not_pdf") {
        return res.status(400).json({ status: "error", code: e.code, message: e.message });
      }
      console.error("[cas] parse failed:", e.message);
      return res.status(500).json({ status: "error", message: "Could not read that statement." });
    }

    // The statement belongs to whoever's PAN is printed on it. Refuse a mismatch outright.
    // A null on either side means "not known", and follows uccPan's rule — log it, do not
    // 403 every investor whose profile happens to carry no PAN.
    const mine = investorPan(req.investor);
    if (mine && parsed.pan && mine !== parsed.pan) {
      return res.status(403).json({
        status: "error",
        code: "cas_pan_mismatch",
        message: "This statement is issued to a different PAN.",
      });
    }
    if (!mine || !parsed.pan) {
      console.warn("[cas] PAN not compared — investor:", Boolean(mine), "statement:", Boolean(parsed.pan));
    }

    const holdings = casHoldings(parsed);
    if (!holdings.length) {
      return res.json({
        status: "success",
        data: {
          period: parsed.period,
          holdings: [],
          message:
            "No open holdings found. Ask CAMS/KFintech for the detailed statement with transactions, for the period 'since inception'.",
        },
      });
    }

    // Link each row to the catalogue by ISIN so it gets the live NAV, the BSE code the NAV
    // socket keys on, and a category — exactly what the Add Fund form attaches when an
    // investor picks a scheme by hand. A fund the catalogue does not carry is still
    // returned: it keeps the NAV printed on the statement, which is better than nothing.
    for (const row of holdings) {
      if (!row.scheme_isin) continue;
      try {
        const { list, warming } = await getCatalogue(this, { isin: row.scheme_isin, length: 1 });
        // Index still building: every further lookup would be one more BSE page fetch, so a
        // 30-holding statement would make thirty of them. Stop — the statement's own NAV is
        // on every row already, and the page re-fetches a missing NAV by itself later
        // (ensureExternalNav, the same path a hand-added holding uses).
        if (warming) {
          console.warn("[cas] catalogue still warming — importing on statement NAVs");
          break;
        }
        const match = list?.[0];
        if (!match) continue;
        row.scheme_bse_code = match.scheme_bse_code || "";
        row.scheme_category = match.category || "";
        row.matched_name = match.name || "";
        // An import reproduces the document. A CAS states units and a NAV as at its own
        // closing date, and that pair is what the statement says the holding was worth —
        // so `nav` stays the statement's and the import's value matches the PDF line for
        // line. Substituting today's price here was read, correctly, as the import having
        // altered a figure printed on the file the investor had just uploaded.
        //
        // Today's price still travels as `current_nav` for the UI to show beside it. It is
        // not needed for valuation: the portfolio prices every external holding from the
        // live AMFI feed on each render (liveNav in ExternalMF), so a saved statement NAV
        // is only the fallback for a scheme the feed does not carry.
        if (Number(match.nav) > 0) {
          row.current_nav = Number(match.nav);
          // Statement printed no NAV of its own — then today's is the only price there is.
          if (!(Number(row.nav) > 0)) {
            row.nav = Number(match.nav);
            row.nav_source = "catalogue";
          }
        }
      } catch (e) {
        console.warn("[cas] catalogue lookup failed for", row.scheme_isin, e.message);
      }
    }

    return res.json({
      status: "success",
      data: { period: parsed.period, pan: parsed.pan, holdings },
    });
  };

  // XSP Methods
  xspRegister = async (req, res) => {
    // Was: `req.body` forwarded to BSE untouched. That let the browser name its own UCC —
    // the same hole bindUcc closes for orders — and it was also why registration never
    // worked: the page sent a hardcoded member code and a blank src_scheme. Build it here.
    const ucc = req.ucc || investorUcc(req.investor);
    if (!ucc) return res.status(400).json({ status: "error", message: "No UCC on this account" });

    const input = req.body?.data || req.body || {};
    const scheme = String(input.scheme || input.src_scheme || "").trim();
    // Tickets 17 and 18: SIP, SWP and STP are one BSE call switching on sxp_type, so this
    // one endpoint registers all three rather than three that would drift apart.
    const type = sxpTypeOf(input);
    if (!type) return res.status(400).json({ status: "error", message: "Choose a valid instruction type" });

    // Audit #42 — an SWP pays money out, so like a redemption it waits for a verified PAN.
    if (type === "swp" && !panVerified(req.investor)) {
      return res.status(403).json({ status: "error", code: "pan_not_verified", message: PAN_NOT_VERIFIED });
    }

    // Ticket 18: "available units/balance must be validated". The holding is BSE's word,
    // not the browser's — a page that believes it holds 900 units does not make it so.
    let available = null;
    if (type === "swp" || type === "stp") {
      available = await this.unitsHeld(ucc, scheme, input.folio || input.src_folio);
      if (available === 0) {
        return res.status(400).json({
          status: "error",
          message: "You hold no units in that folio for this scheme.",
        });
      }
    }

    const invalid = validateSxp({ ...input, sxp_type: type, scheme }, { available });
    if (invalid) return res.status(400).json({ status: "error", message: invalid });

    // Audit #18 — the browser always sends rupees, and units alone said nothing about them:
    // an instalment worth more than the whole folio was registered and failed at BSE every
    // month. Judged on units held × today's NAV; unknown value lets it through to BSE.
    if (type === "swp" && input.isunits !== true && input.all_units !== true) {
      const worth = await this.folioValue(ucc, scheme, input.folio || input.src_folio, available);
      const over = swpOverValue(input.amount, worth);
      if (over) return res.status(400).json({ status: "error", code: "swp_exceeds_holding", message: over });
    }

    // Audit #22 — a SIP may name the investor's own ACTIVE mandate to pay it. Checked against
    // their Laravel rows: a mandate id is BSE's, and naming somebody else's must not work.
    let mandateId = null;
    if (type === "sip" && Number(input.exch_mandate_id) > 0) {
      const mine = await this.ownedMandate(req, input.exch_mandate_id);
      if (mine?.status !== "approved") {
        return res.status(400).json({ status: "error", message: "That auto-debit mandate is not active on your account." });
      }
      mandateId = Number(mine.exch_mandate_id);
    }

    // QA 13.7 — the admin's Min SIP. A SIP only: an STP moves money that is already
    // invested and a SWP takes it out, so a house minimum on contributions says nothing
    // about either. Zero means no house rule, which is how this behaved before the setting
    // had a consumer.
    if (type === "sip") {
      const minSip = (await getLimits()).minSip;
      if (minSip && Number(input.amount) < minSip) {
        return res.status(400).json({ status: "error", message: `Minimum SIP instalment is ₹${minSip}` });
      }
    }

    // A SIP and an STP both BUY — repeatedly — so they take both gates, and an STP is judged
    // on the fund it buys into. A SWP only sells: it skips SUITABILITY for the same reason a
    // redemption does, but still takes the disclaimer gate (ticket 22 names it).
    const sells = type === "swp";
    const target = sells ? null : await this.lookupScheme(type === "stp" ? input.dest_scheme : scheme);
    // SRS §4 — judged on the INSTALMENT, which is the amount that actually moves each
    // time. A ₹5,000 SIP is not a large transaction because it will run for ten years.
    // A SWP only sells, so it is never held: an exit must work on the worst day.
    const gate = await this.gateOrder(req, target, {
      suitability: !sells,
      approval: sells
        ? null
        : {
            kind: type,
            scheme_code: String(type === "stp" ? input.dest_scheme : scheme),
            // mapScheme names it `name`; `scheme_name` was never set, so every held
            // request reached the admin with a blank fund name.
            scheme_name: mapScheme(target || {})?.name || "",
            amount: Number(input.amount) || 0,
            // Audit #49 — enough to place this again from Orders once it is approved.
            intent: {
              sxp_type: type,
              scheme,
              ...(type === "stp" ? { dest_scheme: String(input.dest_scheme || ""), folio: String(input.folio || input.src_folio || "") } : {}),
              amount: Number(input.amount) || 0,
              freq: String(input.freq || "m"),
              start_date: input.start_date || null,
              end_date: input.end_date || null,
            },
            approval_id: input.approval_id,
          },
    });
    if (gate) return res.status(gate.httpStatus || 403).json(gate);

    const kyc = req.investor?.kyc || {};
    const reqObj = buildXspRegisterPayload(
      { ...input, sxp_type: type, scheme },
      {
        ucc,
        memberCode: this.memberCode,
        email: req.investor?.email || "",
        dpId: kyc.dp_id,
        clientId: kyc.client_id,
        mandateId,
        refId: req.consentRef,
      }
    );
    return this.handleTrxnRequest("xspRegister", reqObj, res);
  };
  getAllXsp = async (req, res) => {
    const ucc = req.ucc || investorUcc(req.investor);
    // SIP unless asked otherwise, so every existing caller keeps the list it had. The SWP
    // and STP pages ask for their own type; /sxp_list cannot filter, so this does.
    const type = sxpTypeOf({ sxp_type: req.body?.data?.sxp_type || req.body?.sxp_type }) || "sip";
    // Audit #20 — only Manage SIPs asks for cancelled registrations (its Cancelled tab); the
    // dashboard count and every other reader keep getting live rows only.
    const cancelled = (req.body?.data?.include_cancelled ?? req.body?.include_cancelled) === true;
    const reqObj = buildXspListPayload(req.body?.data, ucc);
    return this.handleTrxnRequest("getAllXsp", reqObj, res, (response) =>
      scopeXspResponse(response, ucc, { type, cancelled })
    );
  };

  /**
   * Run a BSE trxn call and get its body back instead of writing it to a response.
   *
   * Same shim orderHistory uses: handleTrxnRequest only knows how to answer an Express
   * response, and these flows need to read a result and decide what to do next.
   */
  callTrxn(serviceMethod, reqObj) {
    return new Promise((resolve) => {
      this.handleTrxnRequest(serviceMethod, reqObj, {
        json: (data) => resolve(data),
        status: (code) => ({ json: (data) => resolve({ ...data, _status: code }) }),
      });
    });
  }

  /**
   * The SIP this request names, IF it belongs to the caller. Otherwise null.
   *
   * Every manage-a-SIP endpoint below goes through here. They all used to forward req.body
   * to BSE untouched — so a signed-in investor could cancel, pause, resume or top up
   * anybody's SIP just by naming its reg_no, and with no body at all they would operate on
   * a hardcoded demo registration. Tickets 19/20/21 each ask for backend eligibility
   * validation; this is that check, written once where all five callers already route.
   *
   * The list call is scoped by scopeXspResponse, so a row reaching this point is the
   * caller's by construction — there is no second place to get it wrong.
   */
  async loadOwnedSip(req, regNo) {
    const want = String(regNo || "").trim();
    if (!want) return null;
    const ucc = req.ucc || investorUcc(req.investor);
    if (!ucc) return null;
    const response = await this.callTrxn("getAllXsp", buildXspListPayload({ length: 100 }, ucc));
    if (response?._status) return null;
    // activeOnly:false — a cancelled or expired SIP is still this investor's, and the
    // handlers below give a better answer about it than a blanket "no such SIP".
    const scoped = scopeXspResponse(response, ucc, { activeOnly: false });
    const rows = scoped?.data?.lists || scoped?.data?.items || [];
    return rows.find((row) => xspRegNo(row).toUpperCase() === want.toUpperCase()) || null;
  }

  /** reg_no from wherever the caller put it, without letting them name a UCC. */
  static regNoOf(req) {
    const b = req.body?.data || req.body || {};
    return String(b.reg_no ?? b.reg_num ?? b.regNo ?? "").trim();
  }

  /**
   * Shared front half of cancel / pause / resume / top-up / history: find the caller's SIP
   * or refuse. `404` rather than `403` on a SIP that is not theirs — confirming that some
   * other investor's reg_no exists is itself a leak.
   */
  async withOwnedSip(req, res, run) {
    const regNo = StarMFController.regNoOf(req);
    if (!regNo) {
      return res.status(400).json({ status: "error", message: "Which SIP? A registration number is required." });
    }
    const sip = await this.loadOwnedSip(req, regNo);
    if (!sip) {
      return res.status(404).json({ status: "error", message: "No such SIP on this account." });
    }
    return run(sip, regNo, req.body?.data || req.body || {});
  }

  /**
   * The registration's own type, as BSE recorded it.
   *
   * These calls all used to send a hardcoded "SIP", which was true while a SIP was the only
   * thing that could be registered. Now that an SWP or an STP can be, naming the wrong type
   * on a real reg_no is how a cancel silently fails. The row is BSE's own, so this never
   * takes the browser's word for it. Unknown stays "SIP" — the behaviour every existing
   * registration already gets.
   */
  static sxpTypeOfRow = (row = {}) =>
    String(row.sxp_type || row.xsp_type || row.type || "SIP").trim().toUpperCase() || "SIP";

  getXsp = async (req, res) =>
    this.withOwnedSip(req, res, (sip, regNo) =>
      this.handleTrxnRequest(
        "getXsp",
        { data: { reg_no: regNo, sxp_type: StarMFController.sxpTypeOfRow(sip) } },
        res
      )
    );

  getXspTrxnHistory = async (req, res) =>
    this.withOwnedSip(req, res, (sip, regNo, input) =>
      this.handleTrxnRequest(
        "getXspTrxnHistory",
        {
          data: {
            reg_no: regNo,
            fields: ["ALL"],
            filter_param: {
              // BSE REQUIRES this one — omitting it answers `msgid 522, errcode "required",
              // field "NoOfTxn"` and the whole call 502s. It was treated as optional here,
              // so every "Recent SIP payments" load failed and the panel read "No SIP
              // installments recorded yet" no matter how many instalments there were.
              // Probed against the live demo host both ways: without it 522, with it success.
              no_of_txn: Number(input.no_of_txn) > 0 ? Number(input.no_of_txn) : XSP_HISTORY_ROWS,
              ...(input.from_date ? { from_date: String(input.from_date) } : {}),
              ...(input.to_date ? { to_date: String(input.to_date) } : {}),
            },
          },
        },
        res
      )
    );

  /** Ticket 20 — cancel an active SIP. */
  cancelXsp = async (req, res) =>
    this.withOwnedSip(req, res, (sip, regNo, input) => {
      // Eligibility is BSE's word on the registration, not the browser's. A SIP already
      // cancelled or expired must not be sent again — BSE answers that with a code the
      // investor cannot act on.
      const status = String(sip.status || sip.sxp_status || "").toLowerCase();
      if (/cancel|close|expire|stop/.test(status)) {
        return res.status(409).json({ status: "error", message: "This SIP is already cancelled." });
      }
      return this.handleTrxnRequest(
        "cancelXsp",
        buildCancelXspPayload(regNo, { reason: input.reason, sxpType: StarMFController.sxpTypeOfRow(sip) }),
        res
      );
    });

  pauseXsp = async (req, res) =>
    this.withOwnedSip(req, res, (sip, regNo, input) =>
      this.handleTrxnRequest(
        "pauseXsp",
        buildPauseXspPayload(regNo, { installments: input.ninstallments, from: input.paused_from }),
        res
      )
    );

  resumeXsp = async (req, res) =>
    this.withOwnedSip(req, res, (sip, regNo, input) =>
      this.handleTrxnRequest("resumeXsp", buildResumeXspPayload(regNo, { reason: input.resume_reason }), res)
    );

  /** Ticket 19 — Top-Up, against the scheme's own published limits. */
  topupXsp = async (req, res) =>
    this.withOwnedSip(req, res, async (sip, regNo, input) => {
      const limits = await this.sipLimitsFor(sip.src_scheme || sip.scheme || input.scheme);
      const invalid = validateTopup(input, limits);
      if (invalid) return res.status(400).json({ status: "error", message: invalid });
      // Audit #32 — a top-up puts more money into the scheme, so it takes the same gates as
      // the registration it extends (disclaimers, suitability, consent trail). It skipped
      // them all, which made /topupXsp the one buy that needed no acknowledgement. Judged on
      // BSE's own row for this SIP, never on a scheme the browser names.
      const gate = await this.gateOrder(req, await this.lookupScheme(sip.src_scheme || sip.scheme));
      if (gate) return res.status(gate.httpStatus || 403).json(gate);
      return this.handleTrxnRequest(
        "topupXsp",
        buildTopupXspPayload(regNo, input, { email: req.investor?.email || "", refId: req.consentRef }),
        res
      );
    });

  /**
   * Ticket 21 — modify amount / date / frequency.
   *
   * BSE has no sxp_update, so this registers the replacement FIRST and cancels the original
   * only once that succeeded. The other order would mean a failed registration leaves the
   * investor with no SIP at all; this way the worst case is two SIPs, which is visible on
   * the SIPs page and reversible. "Existing SIP data must not be corrupted" picks the order.
   */
  modifyXsp = async (req, res) =>
    this.withOwnedSip(req, res, async (sip, regNo, input) => {
      const ucc = req.ucc || investorUcc(req.investor);
      const status = String(sip.status || sip.sxp_status || "").toLowerCase();
      if (/cancel|close|expire|stop/.test(status)) {
        return res.status(409).json({ status: "error", message: "This SIP is no longer active, so it cannot be modified." });
      }

      const intent = mergeSipChanges(sip, input);
      const limits = await this.sipLimitsFor(intent.scheme);
      const invalid = validateSip(intent, limits.minAmount != null ? { minSip: limits.minAmount } : {});
      if (invalid) return res.status(400).json({ status: "error", message: invalid });

      // A modification registers a fresh SIP, so it is a new purchase instruction and takes
      // the same gates. Skipping it here would make /modifyXsp the way around them.
      const gate = await this.gateOrder(req, await this.lookupScheme(intent.scheme));
      if (gate) return res.status(gate.httpStatus || 403).json(gate);

      const kyc = req.investor?.kyc || {};
      const registered = await this.callTrxn(
        "xspRegister",
        buildXspRegisterPayload(intent, {
          ucc,
          memberCode: this.memberCode,
          email: req.investor?.email || "",
          dpId: kyc.dp_id,
          clientId: kyc.client_id,
          refId: req.consentRef,
        })
      );
      if (registered?._status) {
        // Nothing has changed yet — the original SIP is untouched and still running. BSE's
        // own reason is kept, but the reassurance is appended rather than replaced by it:
        // "BSE said no" on its own leaves the investor wondering if they still have a SIP.
        const why = String(registered.message || "").trim();
        return res.status(registered._status).json({
          status: "error",
          message: `${why ? `${why}. ` : ""}Your existing SIP is unchanged.`,
        });
      }

      const cancelled = await this.callTrxn("cancelXsp", buildCancelXspPayload(regNo, { reason: "Modified by investor" }));
      if (cancelled?._status) {
        // The new SIP is live and the old one is not cancelled. Say so plainly rather than
        // reporting success — the investor would otherwise be debited twice without warning.
        return res.status(207).json({
          status: "partial",
          message:
            "Your new SIP is registered, but the original could not be cancelled. Cancel it from Manage SIPs so you are not debited twice.",
          data: { registered: registered?.data ?? null, old_reg_no: regNo },
        });
      }
      return res.json({
        status: "success",
        message: "SIP updated.",
        data: { registered: registered?.data ?? null, cancelled_reg_no: regNo },
      });
    });

  /**
   * The scheme's own SIP limits, from the same BSE master the fund page reads. Returns {}
   * when the scheme cannot be resolved — an unknown limit is not checked, rather than
   * replaced with a floor nobody published.
   */
  async sipLimitsFor(schemeCode) {
    const code = String(schemeCode || "").trim();
    if (!code) return {};
    try {
      // The index carries minSip (mapScheme reads it out of systematic[]) but deliberately
      // not the max or the multiple — the full frequency rulebook is 40MB+ across 11k
      // schemes, so it is only built on demand by /scheme-details. An unchecked max is the
      // right trade here: BSE still enforces it, the investor just hears about it later.
      const { list } = await getCatalogue(this, { scheme_code: code, length: 1 });
      const row = (list || [])[0];
      return row?.minSip != null ? { minAmount: Number(row.minSip) } : {};
    } catch (e) {
      console.warn("[xsp] scheme limits unavailable:", e.message);
      return {};
    }
  }

  // Order Methods
  purchaseNewOrder = async (req, res) => {
    if (!req.body || !Object.keys(req.body).length) {
      return res.status(400).json({ status: "error", message: "Order payload is required" });
    }
    const parsed = validateOrder(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ status: "error", message: parsed.error });
    }
    // Audit #42 — a redemption pays money out, so it waits for a verified PAN. The browser's
    // KYC check was the only gate, and a direct call walked past it.
    if (String(parsed.order.type || "").toLowerCase() === "r" && !panVerified(req.investor)) {
      return res.status(403).json({ status: "error", code: "pan_not_verified", message: PAN_NOT_VERIFIED });
    }
    // Admin ne scheme chhupayi ho to nayi purchase nahi — list se hatana kaafi nahi,
    // purana buy link kaam karta rehta. Redemption par ye guard nahi lagta: chhupi hui
    // scheme mein pade units nikalne se kabhi nahi roka jata.
    // Audit #46 — a switch BUYS its destination, so a hidden destination is refused too.
    const buying = String(parsed.order.type || "").toLowerCase();
    if (buying === "p" || buying === "sw") {
      const hidden = await getHidden();
      if (isHidden(hidden, { scheme_bse_code: buying === "sw" ? parsed.order.dest_scheme : parsed.order.scheme })) {
        return res.status(403).json({
          status: "error",
          message: "This scheme is not available for investment.",
        });
      }
    }
    const ucc = req.ucc || investorUcc(req.investor);
    const scheme = await this.lookupScheme(parsed.order.scheme);
    // QA 13.7 — the admin's Min Lumpsum, on top of the scheme's own. Only a purchase has a
    // house floor; a redemption is the investor's exit and takes the scheme's minimum alone.
    const houseFloor = String(parsed.order.type || "").toLowerCase() === "p"
      ? (await getLimits()).minLumpsum
      : 0;
    const limits = checkSchemeLimits(parsed.order, scheme, houseFloor);
    if (!limits.ok) {
      return res.status(400).json({ status: "error", message: limits.error });
    }
    // Tickets 22 and 24, on anything that BUYS. A one-off redemption is deliberately exempt
    // from BOTH gates: it is the investor's exit, and it has to work on the worst day. The
    // suitability gate would trap them in a fund their profile no longer permits, and the
    // disclaimer gate fails closed — if /disclaimers is unreachable nothing can be ticked,
    // so gating the sell would mean an outage locks up their money. A SWP is gated instead
    // (see xspRegister): it is a schedule set up in advance, never an emergency exit, and a
    // one-off redemption is still there when it cannot be registered.
    //
    // A switch counts. It buys into dest_scheme, so that is the scheme to judge — judging
    // the source, which is being sold, would make type:"sw" the way around the whole gate.
    const orderType = String(parsed.order.type || "").toLowerCase();
    if (orderType === "p" || orderType === "sw") {
      const target = orderType === "sw" ? await this.lookupScheme(parsed.order.dest_scheme) : scheme;
      // Audit #46 — same fund house, switch allowed out of the source and into the
      // destination, destination open for investment. All of it used to be left to BSE.
      if (orderType === "sw") {
        const refusal = switchRefusal(scheme, target);
        if (refusal) return res.status(400).json({ status: "error", code: "switch_not_allowed", message: refusal });
      }
      // SRS §4 — the amount that would leave the investor's bank is what a threshold is
      // about, so it is judged on the order's own amount, against the scheme being bought.
      const gate = await this.gateOrder(req, target, {
        approval: {
          kind: orderType === "sw" ? "switch" : "purchase",
          scheme_code: String(orderType === "sw" ? parsed.order.dest_scheme : parsed.order.scheme || ""),
          // `name` is what mapScheme returns; `scheme_name` was never set (see xspRegister).
          scheme_name: mapScheme(target || {})?.name || "",
          amount: Number(parsed.order.amount) || 0,
          // Audit #49 — what to place again from Orders once an admin approves it.
          intent:
            orderType === "sw"
              ? {
                  scheme: String(parsed.order.scheme),
                  dest_scheme: String(parsed.order.dest_scheme),
                  folio: String(parsed.order.folio || ""),
                  amount: Number(parsed.order.amount) || 0,
                  all_units: Boolean(parsed.order.all_units),
                }
              : { scheme: String(parsed.order.scheme), amount: Number(parsed.order.amount) || 0 },
          approval_id: req.body?.data?.approval_id,
        },
      });
      if (gate) return res.status(gate.httpStatus || 403).json(gate);
    }
    // QA 3.8 — the same lock-in the browser refuses, refused where a direct API call cannot
    // walk around it. A switch counts: it SELLS the source folio, so the source is what is
    // locked. Fails open in every uncertain case (see mf/lockin.js) — BSE performs the
    // authoritative check, and this must never be the thing that traps an investor's money.
    if (orderType === "r" || orderType === "sw") {
      // Wrapped whole: this guard reads two upstreams (the enrichment feed and order_list),
      // and a redemption must survive both being down. Only a positive verdict may refuse —
      // a THROW here must never be the reason someone cannot reach their own money.
      let verdict = null;
      try {
        // The SAME effective lock-in /scheme-details serves the browser: BSE's own column
        // wins, but it is empty on this host, so an ELSS (locked three years by law) is only
        // visible through the enrichment feed's years. Reading mapScheme alone would make
        // this guard dead code on every scheme we actually have data for.
        const mapped = mapScheme(scheme || {});
        const extra = (await getEnrichment(mapped?.scheme_bse_code || parsed.order.scheme)) || {};
        const lockIn = mapped?.lockIn || lockInFromYears(extra.lockInYears);
        if (lockIn) {
          // null = the list could not be read, which is "unknown", not "empty folio".
          const rows = await this.heldRows(ucc, parsed.order.scheme, parsed.order.folio);
          if (rows) {
            verdict = redemptionVerdict({ lockIn, rows, allUnits: Boolean(parsed.order.all_units) });
          }
        }
      } catch (e) {
        console.warn("[lockin] guard skipped:", e.message);
      }
      if (verdict?.block) {
        return res.status(403).json({ status: "error", message: verdict.reason });
      }
    }
    const mobile = normalizeMobile(parsed.order.mobnum) || investorMobile(req.investor);
    const dp = parsed.order.depository_acct?.dp_id ? parsed.order.depository_acct : await this.lookupDepository(ucc);
    // ponytail: payload wahi jo order 5001433387 par chala tha — scheme code jaisa
    // frontend bheje, mode DP par, aur koi pre-flight guard nahi. Resolved code aur
    // allowedModes ne isay tor diya tha; BSE ko khud faisla karne do.
    const normalized = normalizeOrder(
      { ...parsed.order, ...(req.consentRef ? { mem_ord_ref_id: req.consentRef } : {}), depository_acct: dp || {} },
      // Audit #33 — set only by gateOrder, from the register-checked RM declaration; a
      // redemption never passes the gate, so it stays execution-only as before.
      { ucc, memberCode: this.memberCode, mobile, euin: req.rmEuin || "" }
    );
    const reqObj = { data: { orders: [normalized] } };
    return this.handleTrxnRequest("purchaseNewOrder", reqObj, res);
  };
  updatePurchaseOrder = async (req, res) => {
    if (!req.body || !Object.keys(req.body).length) {
      return res.status(400).json({ status: "error", message: "Order payload is required" });
    }
    return this.handleTrxnRequest("updatePurchaseOrder", bindUcc(req.body, req.ucc, this.memberCode), res);
  };
  getOrder = async (req, res) => {
    if (!req.body || !Object.keys(req.body).length) {
      return res.status(400).json({ status: "error", message: "Order id is required" });
    }
    // An order id on its own names ANY order on the member's book, and the UCC check never
    // looks at an id — so this answered for other investors' orders too. Only the caller's own.
    if (!(await this.ownsOrder(req, req.body?.data?.id ?? req.body?.data?.order_id))) {
      return res.status(404).json({ status: "error", message: "Order not found" });
    }
    return this.handleTrxnRequest("getOrder", req.body, res);
  };

  /** True when `id` is one of the caller's orders: placed through the app, or in their QA book. */
  async ownsOrder(req, id) {
    if (id == null || id === "") return false;
    const want = String(id);
    const canned = qaAnswer("getAllOrders", { data: { filter_param: { ucc: [req.ucc] } } });
    if (canned?.data?.lists?.some((o) => String(o.id) === want)) return true;
    return (await storedOrders(req)).some((o) => String(o.id) === want);
  }

  /**
   * Units this UCC actually holds in a scheme, optionally narrowed to one folio.
   *
   * Ticket 18's "available units/balance must be validated" — against BSE, not against
   * whatever the page believes. Returns null when the holdings cannot be read, which is
   * "unknown" and lets the order through to BSE's own check; returning 0 there would
   * reject a real holding because a list call timed out.
   */
  async unitsHeld(ucc, schemeCode, folio) {
    const mine = await this.heldRows(ucc, schemeCode, folio);
    if (mine === null) return null;
    // No matching row is a real answer — nothing is held here — unlike an unreadable list.
    // Audit #18 — net of what was sold. Adding every row counted a redemption's units as
    // still held (QA1000002 read 523.867 units for the 366.697 the portfolio shows).
    return Math.max(0, Math.round(netUnits(mine) * 1000) / 1000);
  }

  /**
   * Audit #18 — what a folio is worth today: units held × the AMFI NAV the portfolio values it
   * at, behind the same plausibility check (a neighbouring plan's NAV must not refuse anything).
   * null whenever a part is unknown — a missing price is never a reason to stop a withdrawal.
   */
  async folioValue(ucc, schemeCode, folio, units) {
    if (!(Number(units) > 0)) return null;
    const rows = await this.heldRows(ucc, schemeCode, folio);
    if (!rows?.length) return null;
    const isin = rows.map((o) => o.scheme_isin).find(Boolean) || "";
    const invested = netUnits(rows, "amount");
    const { navs } = (await getNavs(this).catch(() => null)) || {};
    const nav = navs ? navFor(navs, isin, schemeCode) : null;
    if (!navLooksPlausible(invested, units, nav)) return null;
    return Math.round(Number(units) * nav * 100) / 100;
  }

  /**
   * The order_list rows for one scheme + folio that represent units actually held.
   *
   * Split out of unitsHeld so the lock-in guard measures the SAME rows the balance check
   * does — two independent readings of "what is in this folio" is how the two would drift
   * apart. Returns null when the list cannot be read, which every caller must treat as
   * "unknown" rather than as an empty folio.
   */
  async heldRows(ucc, schemeCode, folio) {
    const want = String(schemeCode || "").trim().toUpperCase();
    if (!ucc || !want) return null;
    const result = await this.callTrxn("getAllOrders", {
      data: {
        fields: ["ALL"],
        start: 0,
        length: 100,
        filter_param: { ucc: [ucc], member_code: this.memberCode, open_close: "o" },
      },
    });
    if (result?._status) return null;
    const HELD = new Set(["ALLOTTED", "ACCEPTED", "PAID"]);
    const rows = result?.data?.lists || result?.data?.items || result?.items || [];
    const wantFolio = String(folio || "").trim();
    return rows.filter((o) => {
      if (o?.status && !HELD.has(String(o.status).toUpperCase())) return false;
      const code = String(o?.scheme || o?.scheme_code || o?.scheme_bse_code || "").trim().toUpperCase();
      if (code !== want) return false;
      if (!wantFolio) return true;
      return String(o?.folio_num || o?.folio || "").trim() === wantFolio;
    });
  }

  getClientPortfolio = async (req, res) => {
    try {
      // The caller's own UCC only. A body-supplied one was the fallback for an investor with
      // none of their own — which let any logged-in user read another investor's book.
      const ucc = req.ucc || investorUcc(req.investor);
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
      // order_list names the scheme but never its category, so every row used to fall back
      // to the literal "Mutual Fund" and the portfolio allocation pie drew one slice —
      // technically true, useless as a chart. The master index already holds the real
      // category for all 11k schemes; look it up by whichever identifier the row carries.
      const catIndex = schemeCategories();
      const categoryOfRow = (o) =>
        catIndex[String(o.scheme || "").trim().toUpperCase()] ||
        catIndex[String(o.scheme_isin || "").trim().toUpperCase()] ||
        o.scheme_category ||
        "Mutual Fund";
      // A holding is a POSITION, not an order. order_list hands back one row per
      // transaction, and mapping those straight through meant three purchases into one
      // folio showed as three identical lines in the portfolio and three identical
      // entries in the Redeem and Switch dropdowns — with a third of the money on each.
      // Fold them onto scheme + folio, which is what a folio IS.
      //
      // Redemptions and switch-outs have to come back OFF the position; adding their
      // amount would report more invested after selling than before.
      const OUT = /^(r|redeem|redemption|sw[\s_-]*out|switch[\s_-]*out|stp[\s_-]*out|swp)$/i;
      const signOf = (o) => (OUT.test(String(o.trxn_type || o.order_type || "").trim()) ? -1 : 1);

      const byFolio = new Map();
      for (const o of items) {
        const code = String(o.scheme || "").trim();
        const folio = o.folio_num || o.folio || "";
        const key = `${code.toUpperCase()}|${folio}`;
        const sign = signOf(o);
        const existing = byFolio.get(key);
        if (!existing) {
          byFolio.set(key, {
            // ponytail: BSE ke apne key naam — order_list `src_scheme_name` aur `folio_num`
            // deta hai. Purane naam pehle padhe ja rahe the, is liye folio hamesha khali
            // milta tha aur redeem "Folio is missing" par ruk jata.
            scheme_name: o.src_scheme_name || o.scheme_name || o.scheme,
            scheme_bse_code: o.scheme,
            scheme_isin: o.scheme_isin || "",
            inv_amo: sign * Number(o.amount || 0),
            folio,
            units: sign * Number(o.units || 0),
            // Latest NAV wins; an average of NAVs across dates is not a price of anything.
            nav: Number(o.nav || 0),
            status: o.status,
            ret_percentage: 0,
            scheme_category: categoryOfRow(o),
            orders: 1,
          });
          continue;
        }
        existing.inv_amo += sign * Number(o.amount || 0);
        existing.units += sign * Number(o.units || 0);
        existing.orders += 1;
        if (Number(o.nav) > 0) existing.nav = Number(o.nav);
      }

      // Today's price, so a holding can be valued at all.
      //
      // `ret_percentage` used to be the literal 0 on every row. Everything downstream reads
      // it: the dashboard's Returns tile, the sort-by-returns control, and — through
      // `currentValue = invested + returns` — the input to XIRR. So the portfolio reported a
      // flat 0% return and a ~0% p.a. rate with total confidence, on any account.
      //
      // The `nav` on an order_list row is the ALLOTMENT nav, the price that was paid; it
      // cannot value anything today. This is the same AMFI store the fund pages price from.
      // A scheme it does not know stays null rather than 0 — "not known" and "no gain" are
      // different answers and only one of them is honest.
      // `{ navs }` — getNavs returns the wrapper { at, loaded, date, navs } and every lookup
      // helper wants the flat map inside it. Passing the wrapper looks fine and silently
      // resolves nothing, which is how this shipped once already.
      const { navs } = (await getNavs(this).catch(() => null)) || {};

      const holdings = Array.from(byFolio.values())
        // A folio sold down to nothing is not a holding. Keeping it would offer the
        // investor a Redeem button for units they no longer have.
        .filter((h) => h.inv_amo > 0 || h.units > 0)
        .map((h) => {
          const inv = Math.round(h.inv_amo * 100) / 100;
          const units = Math.round(h.units * 1000) / 1000;
          const today = navs ? navFor(navs, h.scheme_isin, h.scheme_bse_code) : null;

          // A NAV far from what was actually paid per unit belongs to a different plan under
          // a neighbouring ISIN, not to this holding. Refuse to value rather than publish it.
          const plausible = navLooksPlausible(inv, units, today);
          const value = plausible && units > 0 ? units * today : null;
          return {
            ...h,
            inv_amo: inv,
            units,
            // Only report the price we were willing to value at, so the UI never shows a
            // NAV next to a blank valuation and invites someone to do the sum themselves.
            current_nav: plausible ? today : null,
            current_value: value == null ? null : Math.round(value * 100) / 100,
            ret_percentage:
              value == null || inv <= 0 ? null : Math.round(((value - inv) / inv) * 10000) / 100,
          };
        });
      // ponytail: unpaid orders holding nahi hain, magar UI ko farq batana hai —
      // "kuch invest hi nahi kiya" aur "payment adhoori hai" ek jaisa nahi dikhna chahiye.
      const pending = rows.length - items.length;
      return res.json({ status: "success", data: { holdings, count: holdings.length, pending } });
    } catch (error) {
      return res.status(500).json({ status: "error", message: error.message });
    }
  };

  /**
   * Every order this UCC has ever placed — the investor-facing transaction history.
   *
   * getClientPortfolio asks the same BSE endpoint but keeps only open, allotted orders,
   * because it is building a holdings list. History is the opposite: a rejected purchase
   * and a completed redemption are exactly what the investor came to look at.
   *
   * BSE's order_list needs `open_close`, and its own sample only ever sends "o" — whether
   * it can be omitted is unproven, so this asks for each side separately with the payload
   * shape that is known to work and merges the two. If the closed leg fails, the open one
   * still answers and the page shows what it can rather than erroring out.
   */
  orderHistory = async (req, res) => {
    try {
      // The caller's own UCC only. A body-supplied one was the fallback for an investor with
      // none of their own — which let any logged-in user read another investor's book.
      const ucc = req.ucc || investorUcc(req.investor);
      if (!ucc) {
        return res.status(400).json({ status: "error", message: "ucc is required" });
      }

      const fetchSide = async (openClose) => {
        const reqObj = {
          data: {
            fields: ["ALL"],
            start: 0,
            length: 100,
            filter_param: { ucc: [ucc], member_code: this.memberCode, open_close: openClose },
          },
        };
        const result = await new Promise((resolve) => {
          this.handleTrxnRequest("getAllOrders", reqObj, {
            json: (data) => resolve(data),
            status: (code) => ({ json: (data) => resolve({ ...data, _status: code }) }),
          });
        });
        if (result?._status) {
          console.warn("[orders] BSE order_list failed", { ucc, open_close: openClose, status: result._status });
          return [];
        }
        return result?.data?.lists || result?.data?.items || result?.items || [];
      };

      const [open, closed] = await Promise.all([fetchSide("o"), fetchSide("c")]);

      // The same order can surface on both legs while it is settling; the id is BSE's,
      // so dedupe on it and fall back to a composite key when a row carries none.
      const seen = new Set();
      const merged = [...open, ...closed].filter((o) => {
        const key = String(o?.id ?? o?.order_id ?? `${o?.scheme}|${o?.order_date}|${o?.amount}`);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // BSE spells the same field several ways across endpoints, so read every alias the
      // rest of this controller already knows about rather than guessing one.
      const orders = merged.map((o) => ({
        id: o.id ?? o.order_id ?? null,
        date: o.order_date || o.trxn_date || o.created_at || null,
        scheme_name: o.src_scheme_name || o.scheme_name || o.scheme || "",
        scheme_bse_code: o.scheme || o.scheme_code || "",
        type: o.trxn_type || o.order_type || o.transaction_type || "",
        amount: Number(o.amount || 0),
        units: Number(o.units || 0),
        nav: Number(o.nav || 0),
        folio: o.folio_num || o.folio || "",
        status: o.status || "",
        remarks: o.remarks || o.message || "",
      }));

      // QA 3.4 — "nothing gets updated in /user/mutual_fund/orders, only in /user/order".
      //
      // This read BSE's order_list and nothing else. An order placed through the app is
      // written to Laravel's `bse_orders` the moment it is accepted, but BSE's own list can
      // take a settlement cycle to show it — and on a demo UCC it may never. /user/order
      // reads Laravel directly, so the same order appeared there and not here. Two pages,
      // one query key, two different answers.
      //
      // Merged here rather than in either page: both already call this endpoint, so the
      // fix lands once instead of twice, and every future caller inherits it.
      const stored = await storedOrders(req);
      // Audit #48 — status sync without a cron. BSE has just said where each order stands, so
      // any stored order it has settled (allotted / rejected / cancelled) is reported to
      // Laravel, which records it and tells the investor once per change. Not awaited: a page
      // load must not wait on an email being sent.
      reportStatusChanges(req, statusChanges(stored, orders)).catch(() => {});
      const known = new Set(orders.map((o) => orderKey(o)));
      const storedById = new Map(stored.filter((r) => r.id != null).map((r) => [String(r.id), r]));
      for (const o of orders) {
        // A row BSE names only by its scheme code takes the name the investor saw when it
        // was placed, which Laravel kept (Audit #11: a basket leg read as a bare code).
        const mine = storedById.get(String(o.id));
        if (mine?.scheme_name && (!o.scheme_name || o.scheme_name === o.scheme_bse_code)) o.scheme_name = mine.scheme_name;
      }
      for (const row of stored) {
        if (!known.has(orderKey(row))) orders.push(row);
      }

      // Newest first. Rows with no date sink to the bottom rather than jumbling the top.
      orders.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

      return res.json({ status: "success", data: { orders, count: orders.length } });
    } catch (error) {
      return res.status(500).json({ status: "error", message: error.message });
    }
  };

  /**
   * Audit #49 — cancel a lumpsum purchase BSE has not settled yet.
   *
   * Was: the body forwarded to BSE with only the UCC rebound, so any order id on the member's
   * book could be named, and nothing said whether it was a purchase or already allotted. Now:
   * the caller's own order (Laravel's record or their QA book), a purchase, not final — then
   * BSE decides, in the template's shape. A cancel BSE accepts is recorded as Cancelled.
   */
  cancelPurchaseOrder = async (req, res) => {
    const input = req.body?.data || req.body || {};
    const id = String(input.id ?? input.order_id ?? "").trim();
    if (!id) return res.status(400).json({ status: "error", message: "Order id is required" });

    const canned = qaAnswer("getAllOrders", { data: { filter_param: { ucc: [req.ucc] } } })?.data?.lists?.find(
      (o) => String(o.id) === id
    );
    const stored = canned ? null : (await storedOrders(req)).find((o) => String(o.id) === id);
    const mine = canned || stored;
    if (!mine) return res.status(404).json({ status: "error", message: "Order not found" });

    const type = String(canned ? canned.trxn_type : stored.type);
    if (!/^(p|purchase)$/i.test(type)) {
      return res.status(409).json({ status: "error", message: "Only a lumpsum purchase can be cancelled here." });
    }
    if (/ALLOT|COMPLET|REJECT|CANCEL|FAIL/i.test(String(mine.status))) {
      return res.status(409).json({ status: "error", message: `This order is already ${String(mine.status).toLowerCase()}.` });
    }

    // pan_holders / holding_nature come from BSE's own UCC record; a QA book has none.
    const info = canned ? null : await this.lookupUcc(req.ucc);
    const result = await this.callTrxn("cancelPurchaseOrder", buildCancelOrderPayload(id, { ucc: req.ucc, info, remark: input.remark }));
    const failure = result?._status ? String(result.message || "BSE did not cancel the order.") : bseFailure(result);
    if (failure) return res.status(502).json({ status: "error", message: failure });

    await reportStatusChanges(req, [
      { bse_order_id: Number(id), state: "cancelled", bse_status: "CANCELLED", remarks: "Cancelled by investor" },
    ]);
    return res.json({ status: "success", message: "Order cancelled.", data: result?.data ?? null });
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
        { headers: { Authorization: `Bearer ${this.accessToken}` }, timeout: 15000 }
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

  // ponytail: KYC ka verdict yahin se — Laravel is endpoint ko investor ke bearer ke saath
  // poochta hai aur dono kyc_status columns khud likhta hai; browser kabhi nahi. lookupUcc
  // ka 60s cache jaan-boojh kar reuse hai: fail ke baad ek minute tak wahi jawab dohrayega.
  kycBseStatus = async (req, res) => {
    // ponytail: ye explicit "abhi poocho" hai — 60s cache yahan galat hai, kyunki fail ke
    // baad ka null bhi cache hota hai aur "Check again" ek minute tak wahi purana jawab
    // dohrata rehta. Order path ka cache waise hi rehta hai.
    delete this._uccCache[req.ucc];
    const record = await this.lookupUcc(req.ucc);
    if (!record) {
      // lookupUcc null deta hai chahe BSE down ho ya UCC hai hi nahi — dono ko ek hi
      // sach mat batao, log/support isi message ko padhte hain.
      return res.status(502).json({ status: "error", message: "Could not read this UCC from BSE" });
    }

    // Client code browser se aata hai, is liye maalik ka faisla BSE ke record se hota hai:
    // kisi aur ke APPROVED UCC par apna KYC verified karwana yahin rukta hai.
    const owner = uccPan(record);
    const mine = investorPan(req.investor);
    if (owner && mine && owner !== mine) {
      console.warn("[kyc] UCC PAN mismatch", { ucc: req.ucc, owner, investor: req.investor?.id });
      return res.status(403).json({ status: "error", message: "This UCC belongs to a different PAN" });
    }
    if (!owner || !mine) {
      // Fail-open, par chup-chaap nahi: agar BSE ne shape badli to ye line logs mein dikhegi.
      console.warn("[kyc] UCC ownership unverified", { ucc: req.ucc, bsePan: Boolean(owner), investorPan: Boolean(mine) });
    }

    const verdict = kycFromUcc(record, req.ucc, IS_BSE_DEMO);
    if (verdict.kyc_status === "unknown") {
      // Field rename yahin pakda jayega — warna investor hamesha "awaiting verification" dekhta hai.
      console.warn("[kyc] unmapped ucc_status from BSE", { ucc: req.ucc, ucc_status: record?.ucc_status });
    }
    if (verdict.auto_verified_on_demo) {
      // Loud on purpose: this is the only trace that a UAT UCC was passed through.
      console.warn("[kyc] UAT host — PENDING_VERIFICATION treated as verified", { ucc: req.ucc });
    }
    return res.json({ status: "success", data: verdict });
  };

  async lookupScheme(code) {
    if (!code) return null;
    const needle = String(code).trim().toUpperCase();
    // A scheme in the QA book answers from the book (only while MF_QA_UCC is set).
    const canned = qaScheme(needle);
    if (canned) return canned;
    // Dev only (MF_AMFI_FALLBACK=1, never set in production) and only while BSE has not
    // logged us in: the same AMFI rows the catalogue lists on a box BSE will not talk to, so
    // a fund picked from that list can be ordered against the QA book. They carry no BSE
    // flags or minimums — every gate still runs, with the admin's house floor as the minimum.
    if (AMFI_FALLBACK && !this.accessToken) {
      const amfi = ((await getAmfiNavs()).schemes || []).find(
        (r) => String(r.scheme_bse_code || "").toUpperCase() === needle || String(r.scheme_isin || "").toUpperCase() === needle
      );
      if (amfi) return amfi;
    }
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
    // QA 6.2 — read once, and key the cache on it: an Explore card and the fund page it
    // opens were quoting different minimums for the same fund.
    const limits = await getLimits();
    const cacheKey = listCacheKey(q, limits);
    const cached = getListCache(cacheKey);
    if (cached) return res.json(cached);

    try {
      // getCatalogue poore cached master par filter lagata hai aur page uske BAAD kaatta
      // hai — `total` filter ke baad ki ginti hai, is liye frontend ka page count sach
      // bolta hai. Yahan dobara query() nahi: wo page ko dobara filter kar ke total
      // aur rows ko alag kar deta tha.
      const { list: pageRows, total, priced, fetched, unpriced, fields, sample, warming, enrichment, facets } = await getCatalogue(this, q);

      // The page rows are a fresh ARRAY but THE SAME OBJECTS as the process-wide master
      // index (catalogue.js: `rows.slice(...)`), and applyFloor writes in place. Flooring
      // them directly would raise the index itself — permanently, and again on every later
      // read, so the number would climb each time the admin touched the setting. Shallow
      // copy is enough: mapScheme flattens the minimums onto the row as scalars, and the
      // only nested value (`txn`) is a set of booleans applyFloor never looks at.
      const lists = pageRows.map((row) => {
        const copy = { ...row };
        applyFloor(limits, copy);
        // Audit #2 — say which minimums are the platform's own rule, not BSE's; Audit #3 —
        // the same lock-in the fund page shows (an ELSS card no longer reads "no lock-in").
        copy.minSource = minSources(row, copy);
        copy.lockIn = effectiveLockIn(copy);
        return copy;
      });

      const lookedUp = q.search || q.isin || q.scheme_code || q.category;
      if (!lists.length && !fetched && !lookedUp) {
        // stale-if-error: kal ka catalogue dikhana 502 se behtar hai.
        const stale = getListCache(cacheKey, true);
        if (stale) return res.json(stale);
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
          // `enrichment` is how far the risk/age/returns warm pass has got. The risk and
          // returns FILTERS can only match rows it has already reached, so a client that
          // wants to be honest about coverage has the numbers to say so.
          catalogue: { priced, fetched, unpriced, fields, sample, enrichment: enrichment || null },
          // True only while the master index is still building: `total` is then this page's
          // own row count, not the catalogue's. Dropping this flag was what let the
          // warm-up page look like an authoritative answer.
          warming: warming === true,
          // Audit #11 — the Category → Sub-category filter's options, in the catalogue's words.
          facets: facets || [],
          lists,
        },
      };
      // A warm-up page must not be cached — 5 minutes normally, and up to 24h as
      // stale-if-error. Caching it would keep serving a 20-row "whole catalogue" long
      // after the real index had landed.
      if (!warming) setListCache(cacheKey, payload);
      res.json(payload);
    } catch (error) {
      const stale = getListCache(cacheKey, true);
      if (stale) {
        console.warn("[mf] BSE list failed, serving stale:", error.message);
        return res.json(stale);
      }
      res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
  };

  /**
   * Get Detailed info for a particular fund including Chart data and Advanced Ratios
   */
  getSchemeDetails = async (req, res) => {
    try {
      // `option` (Audit #1) — "idcw-payout" / "idcw-reinvestment" from an ISIN-only fund URL:
      // BSE files both options under one ISIN, so the ISIN alone can name either.
      const { isin, scheme_code, option } = req.body;
      if (!isin && !scheme_code) {
        return res.status(400).json({ status: "error", message: "isin or scheme_code is required" });
      }

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
      // A QA book scheme (by its BSE code, MF_QA_UCC only) answers with the book's master row,
      // so the Redeem/Switch forms see the same rulebook its orders are judged on.
      let scheme = qaScheme(scheme_code);
      // Dev only — the recorded live catalogue answers before AMFI or BSE (null unless
      // MF_DEV_CATALOGUE_SNAPSHOT is set; see mf/devSnapshot.js).
      const snap = scheme ? null : snapshotScheme(isin, scheme_code, option);

      // This path queries BSE directly rather than through catalogue.js, so it needs the
      // same AMFI fallback — otherwise every card the AMFI-backed list rendered opens on
      // "Scheme not found".
      //
      // ponytail: checked FIRST when the flag is on. The flag means BSE is known
      // unreachable (dev box is not IP-whitelisted), and its 21s timeout would otherwise
      // be paid on every fund page before falling back. Flag off = untouched BSE-only path.
      if (!scheme && !snap && AMFI_FALLBACK) {
        const want = needles.map((v) => String(v).trim().toUpperCase());
        scheme = ((await getAmfiNavs()).schemes || []).find((row) =>
          want.includes(String(row.scheme_isin || "").toUpperCase()) ||
          want.includes(String(row.scheme_bse_code || "").toUpperCase())
        ) || null;
        if (scheme) console.warn("[mf] AMFI fallback — scheme-details:", scheme.scheme_name);
      }

      if (!scheme && !snap) {
        // Moved down from the top of the handler: logging in to BSE is only worth its
        // round trip if we are about to query BSE. An AMFI hit above needs no token, and
        // on an unreachable host that login is a 21s wait on every fund page.
        if (!this.accessToken) await this.loginFunc();
        for (const value of needles) {
          const schemesRes = await searchBse(value);
          scheme = pickScheme(schemesRes?.data?.lists || [], isin, scheme_code, option);
          if (scheme) break;
        }
      }

      if (!scheme && !snap) return res.status(404).json({ status: "error", message: "Scheme not found" });
      const mapped = snap ? snap.row : mapScheme(scheme);
      // The 500 / 5000 that used to be pinned on here were the "hardcoded placeholder
      // values" the ticket calls out: BSE's real minimums live inside lumpsum[]/systematic[]
      // and mapScheme now reads them. Null still means BSE did not say — the UI omits the
      // line rather than inventing a floor the exchange never set.
      const transactions = snap ? snap.transactions : schemeTransactions(scheme);

      // QA 6.2 — the admin's own Min Lumpsum / Min SIP, applied where the page READS the
      // number rather than only where the order path refuses it. Both objects are freshly
      // built above, so raising them in place affects nothing else.
      const own = { minLumpsum: mapped.minLumpsum, minSip: mapped.minSip, minAdditional: transactions.lumpsum?.minAdditional ?? null };
      const limits = await getLimits();
      applyFloor(limits, mapped, transactions);
      // Audit #2 — "Min. for 2nd investment onwards" is BSE's additional-purchase minimum
      // (it used to print the REDEMPTION minimum). The platform's lumpsum floor binds every
      // purchase, top-ups included (purchaseNewOrder's houseFloor), so it lifts this one too —
      // through applyFloor itself, so the rule lives in one place.
      const topUp = { minLumpsum: own.minAdditional };
      applyFloor(limits, topUp);
      mapped.minAdditional = topUp.minLumpsum ?? null;
      // ...and the page labels a minimum that only the platform set as the platform's.
      mapped.minSource = minSources(own, mapped);

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

      // Ticket 5 — the AMC's monthly portfolio disclosure, as uploaded through the admin
      // panel. Fail-open: no upload for this scheme means the holdings sections stay hidden,
      // exactly as before.
      const profile = fundProfile(await getHoldings(mapped.scheme_isin, mapped.scheme_bse_code || scheme_code));
      const ratios = ratiosFromSeries(mf?.series || []);
      // Category average + rank, read off the in-memory master index. No network: the peer
      // NAV fan-out this replaces is what used to time out at nginx, which is why both rows
      // had been reading "NA" on every fund.
      const { categoryAvg, rank, peers: categoryPeers, rankedOf, categoryLabel } = categoryRanking(mapped);

      const series = mf?.series || [];
      // Both forms of every period (Absolute / CAGR toggle) and the rolling-return
      // distribution, all from the same real NAV series. Empty series => every value null,
      // never a fabricated one.
      const periodReturns = returnsBoth(series);
      const rolling = rollingReturns(series);

      // Alpha/Beta need a benchmark. The scheme's own (`scheme_benchmark`) is preferred, but
      // it is empty for every scheme on the host we are pointed at, which is why both tiles
      // were blank. Falling back to the index SEBI prescribes for the category gives a real
      // number for most equity schemes — and `benchmarkSource` tells the page which it was,
      // so a category benchmark is never shown as if the AMC had named it.
      // Unrecognised benchmark or an unreachable index still means no tiles, never invented ones.
      let risk = null;
      // Audit #5 — a fund with a NAV history but no Alpha/Beta says why, instead of two
      // tiles that silently vanish: no priceable index for its category (debt, hybrid, gold,
      // international…), or one that exists but could not be measured against today.
      let alphaBetaNa = null;
      try {
        const pick = benchmarkFor(mapped);
        const bench = await benchmarkSeries(pick.name);
        const ab = bench ? alphaBeta(series, bench.series) : null;
        if (ab) {
          risk = {
            ...ab,
            benchmark: bench.label,
            benchmarkRaw: bench.raw,
            benchmarkIsPriceIndex: bench.isPriceIndex,
            benchmarkSource: pick.source,
          };
        } else if (series.length) {
          alphaBetaNa = !resolveBenchmark(pick.name)
            ? "no benchmark series"
            : bench
            ? "too little shared history with its benchmark"
            : "benchmark series unavailable";
        }
      } catch (e) {
        console.warn("[mf] alpha/beta unavailable:", e.message);
      }

      // Manager, objective and the SEBI risk level — none of them exist in BSE's master.
      // Dev snapshot: the recorded row carries the live site's copy, used when the feed misses.
      const extra = (await getEnrichment(mapped.scheme_bse_code || scheme_code)) || snap?.row || {};

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
            advancedRatios: {
              ...ratios,
              // The index goes out with the numbers, never separately: Alpha and Beta only
              // mean something next to what they were measured against.
              ...(risk
                ? {
                    alpha: risk.alpha,
                    beta: risk.beta,
                    benchmark: risk.benchmark,
                    benchmarkSource: risk.benchmarkSource,
                    benchmarkIsPriceIndex: risk.benchmarkIsPriceIndex,
                  }
                : alphaBetaNa
                ? { alphaBetaNa }
                : {}),
            },
            holdings: profile.holdings,
            risk: mapped.risk || extra.risk || null,
            riskRank: extra.riskRank ?? null,
            fundManagers: extra.fundManagers || [],
            objective: extra.objective || null,
            factsheetUrl: extra.factsheetUrl || null,
            // Audit #5 — the only link the fund page may send an investor off-site with: the
            // scheme's SID / KIM / SAI page, when that is what the feed's link is.
            documentsUrl: documentsUrl(extra.factsheetUrl),
            fundRating: extra.fundRating ?? null,
            // Ticket 3 — fund size, in ₹ crore. The unit is normalised inside kuvera.js so
            // nothing downstream has to know what the feed sends.
            aum: extra.aum ?? null,
            aumUnit: extra.aumUnit ?? null,
            expense: mapped.expense || extra.expense || null,
            // BSE's own lock-in wins; its column is empty on this host, which is why an ELSS
            // (locked three years by law) was showing none at all. Kuvera's value is in years.
            // Audit #3 — one rule shared with the cards and Compare (scheme.effectiveLockIn).
            lockIn: effectiveLockIn(mapped, extra.lockInYears),
            // "Plan inception": for a scheme older than 2013 the direct plan genuinely
            // starts 2013-01-01, so this is the plan's birthday, not the fund's.
            inceptionDate: extra.inceptionDate || periodReturns.inceptionDate || null,
            ageYears: extra.ageYears ?? periodReturns.years ?? null,
            transactions,
          },
          returns,
          periodReturns,
          rollingReturns: rolling,
          riskMetrics: risk,
          transactions,
          chartData,
          synthetic: !realSeries.length,
          holdings: profile.holdings,
          assetSplit: profile.assetSplit,
          sectors: profile.sectors,
          // A portfolio is a point-in-time fact; the page says which month it is showing.
          holdingsAsOf: profile.holdingsAsOf,
          categoryAvg,
          rank,
          categoryPeers,
          // How many schemes each rank was actually drawn from — NOT the size of the category.
          // The enrichment cache is empty for the first hour after a container restart, so a
          // category of 162 can have six funds with a 3Y figure in it; printing "rank 1 of
          // 162" then would be a flattering lie that heals itself an hour later, which is the
          // worst kind. The page prints this denominator beside every rank.
          rankedOf,
          categoryLabel,
        }
      });

    } catch (error) {
      console.error("Get Scheme Details Error:", error);
      return res.status(500).json({ status: "error", message: error.message });
    }
  };

  /**
   * Fund comparison — several schemes on one overlapping chart.
   *
   * The whole difficulty is inception dates. Two funds launched nine years apart cannot be
   * drawn on one axis by plotting raw NAV: the y-axis is meaningless across funds (a ₹15
   * NAV is not "cheaper" than a ₹1,700 one), and the older fund's extra history makes it
   * look like the younger one collapsed to nothing.
   *
   * So: find the latest inception among the funds picked, that is the only window all of
   * them actually lived through, rebase every fund to 100 on that date, and say in the
   * response which date that was and which fund set it. A fund with no NAV history at all
   * comes back with `series: []` and an explicit reason instead of taking the comparison
   * down with it.
   */
  compareSchemes = async (req, res) => {
    const body = req.body || {};
    const raw = Array.isArray(body.schemes) ? body.schemes : Array.isArray(body.data?.schemes) ? body.data.schemes : [];
    // ponytail: each entry is a NAV-history download on a cold cache; five is already a
    // wide comparison and keeps the endpoint inside nginx's read timeout.
    const MAX = 5;
    const picks = raw
      .map((s) => ({
        isin: String(s?.isin || s?.scheme_isin || "").trim(),
        code: String(s?.scheme_code || s?.code || s?.scheme_bse_code || "").trim(),
      }))
      .filter((s) => s.isin || s.code)
      .slice(0, MAX);

    if (picks.length < 2) {
      return res.status(400).json({ status: "error", message: "Pick at least two schemes to compare" });
    }

    try {
      const loaded = await Promise.all(
        picks.map(async (p) => {
          let scheme = null;
          // Dev only — the recorded live catalogue, so a dev box skips BSE's 21s timeout.
          const snap = snapshotScheme(p.isin, p.code);
          try {
            if (!snap) scheme = await this.lookupScheme(p.code || p.isin);
          } catch (e) {
            console.warn("[mf] compare lookup failed:", p.code || p.isin, e.message);
          }
          const mapped = snap ? snap.row : scheme ? mapScheme(scheme) : null;
          const name = mapped?.name || p.code || p.isin;
          let series = [];
          try {
            const mf = await loadFundNav(p.isin || mapped?.scheme_isin, name);
            series = mf?.series || [];
          } catch (e) {
            console.warn("[mf] compare NAV failed:", name, e.message);
          }
          const extra = (await getEnrichment(mapped?.scheme_bse_code || p.code)) || snap?.row || {};
          return {
            name,
            scheme_isin: mapped?.scheme_isin || p.isin || null,
            scheme_bse_code: mapped?.scheme_bse_code || p.code || null,
            category: mapped?.category || null,
            subType: mapped?.subType || null,
            plan: mapped?.plan || null,
            nav: mapped?.nav ?? null,
            risk: mapped?.risk || extra.risk || null,
            expense: mapped?.expense || extra.expense || null,
            fundRating: extra.fundRating ?? null,
            inceptionDate: extra.inceptionDate || null,
            // Audit #10 — the table's Age column read a field this response never carried.
            ageYears: extra.ageYears ?? null,
            // Audit #3 — the same lock-in rule as the fund page (an ELSS shows its 3 years).
            lockIn: effectiveLockIn(mapped || {}, extra.lockInYears),
            txn: mapped?.txn || null,
            series,
          };
        })
      );

      const withHistory = loaded.filter((f) => f.series.length > 1);
      // Latest first-NAV across the picks = the only stretch every one of them existed for.
      const commonStart = withHistory.length ? Math.max(...withHistory.map((f) => f.series[0].timestamp)) : null;
      const limiting = commonStart ? withHistory.find((f) => f.series[0].timestamp === commonStart)?.name || null : null;

      const funds = loaded.map((f) => {
        if (!f.series.length) {
          return { ...f, series: [], rebased: [], returns: null, unavailable: "No NAV history published for this scheme" };
        }
        const window = commonStart ? f.series.filter((p) => p.timestamp >= commonStart) : f.series;
        const base = window[0]?.nav;
        const rebased = base > 0 ? window.map((p) => ({ timestamp: p.timestamp, value: parseFloat(((p.nav / base) * 100).toFixed(4)), nav: p.nav })) : [];
        const { series, ...rest } = f;
        const returns = returnsBoth(f.series);
        return {
          ...rest,
          // Audit #10 — the feed's age when it has one, else the NAV history's own span: the
          // same fallback the fund page uses, so the two never disagree on a fund's age.
          ageYears: rest.ageYears ?? returns.years ?? null,
          inceptionDate: rest.inceptionDate || returns.inceptionDate || null,
          points: window.length,
          rebased,
          // Trailing returns stay on the fund's own full history — that is what a fund card
          // means by "3Y". The rebased line is the like-for-like view; these two answer
          // different questions and the UI labels them separately.
          returns,
          windowReturn:
            base > 0 && window.length > 1
              ? parseFloat((((window[window.length - 1].nav - base) / base) * 100).toFixed(2))
              : null,
        };
      });

      return res.json({
        status: "success",
        data: {
          commonStart: commonStart ? new Date(commonStart * 1000).toISOString().slice(0, 10) : null,
          // Naming the fund that shortened the window is the difference between "the chart
          // starts in 2019" and "it starts in 2019 because THIS fund launched then".
          limitedBy: limiting,
          rebasedTo: 100,
          funds,
        },
      });
    } catch (error) {
      console.error("Compare schemes error:", error);
      return res.status(500).json({ status: "error", message: error.message });
    }
  };

  // NFT Service Method

  // ponytail: teeno handler req.body dekhte hi nahi — nftRequestData ka hardcoded
  // sample payload seedha BSE ko jata hai. Yaani endpoint request se wired nahi hai:
  // asli bank/nominee/contact change karne se pehle body -> reqObj mapping likhni
  // padegi. Route ...auth par hai, magar guard is gap ko bharta nahi.
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
    // ponytail: UCC na mile to PAN khali jata hai aur BSE cryptic 507 deta hai —
    // "No valid responses generated". Yahin rok do, wajah saaf rahegi.
    const info = await this.lookupUcc(ucc);
    if (!info) {
      return res.status(404).json({ status: "error", message: `UCC ${ucc} not found on BSE` });
    }
    const reqObj = twoFaUccPayload(event, { ucc, info, memberCode: this.memberCode });
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
      // The caller's own mem_details is deliberately NOT spread over this any more: it was
      // the last place a browser could put an EUIN into a payload bound for BSE, and the
      // block it used to default to declared nothing at all (euin_flag false with an empty
      // euin is "not declared", not "execution-only").
      payload.data.mem_details = { member: this.memberCode, ...memDetails() };
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
        httpsAgent: this.httpsAgent,
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
  /**
   * e-NACH / UPI AutoPay registration — §2 row 5 and §3.A of the compliance spec.
   *
   * Two things changed here, both compliance rather than plumbing:
   *
   * 1. It is no longer something that happens TO the investor. The SIP page used to fire
   *    this silently the moment a registration succeeded, so a bank authorisation with a
   *    standing debit limit was created as a side effect of buying, with the limit never
   *    shown. The spec requires an explicit act, so this refuses a request that does not
   *    carry `authorized: true` from the screen that displayed the limit.
   *
   * 2. The payload is bound server-side. It used to forward `req.body` untouched, meaning
   *    the browser chose the UCC, the member code and the mandate amount.
   *
   * Audit #22 — and it now does the job end to end: the investor chooses how to authorise
   * (UPI AutoPay / NetBanking / Debit card / Aadhaar eSign — see mf/mandate.js for what BSE's
   * templates make of each), a UPI ID is required and checked for UPI, the payload comes from
   * the template for that channel, and success means BSE said success. It used to answer 200
   * with BSE's error body inside, which the page read as "Auto-debit authorised." BSE's
   * approval link goes back to the investor; the mandate is filed in Laravel (which sends the
   * "action required" notice) and linked to the SIP it was set up for.
   */
  mandateRegisterUpiAutoPay = async (req, res, defaultMode) => {
    const body = req.body || {};
    if (body.authorized !== true) {
      return res.status(400).json({
        status: "error",
        code: "mandate_not_authorized",
        message: "An auto-debit mandate needs your explicit authorisation. Nothing has been registered.",
      });
    }

    // The ceiling is the platform's, not the browser's. A mandate limit is the most an
    // account can ever be debited under it, so an unbounded one from a request body is
    // the single most costly field on this endpoint to get wrong.
    const requested = Number(body?.data?.amount) || 0;
    const ceiling = Number(process.env.MANDATE_MAX_LIMIT || 100000);
    if (!(requested > 0) || requested > ceiling) {
      return res.status(400).json({
        status: "error",
        code: "mandate_limit_invalid",
        message: `An auto-debit limit must be between ₹1 and ₹${ceiling.toLocaleString("en-IN")}.`,
      });
    }

    // Express hands a route its `next` as the third argument; only the register aliases
    // pass a real default channel. UPI stays the default the existing route always meant.
    const mode = String(body.mode || (typeof defaultMode === "string" ? defaultMode : "upi")).trim().toLowerCase();
    if (!MANDATE_MODES[mode]) {
      return res.status(400).json({ status: "error", code: "mandate_mode_invalid", message: "Choose UPI AutoPay, NetBanking, Debit card or Aadhaar eSign." });
    }
    const vpa = String(body.vpa || "").trim();
    if (mode === "upi" && !validVpa(vpa)) {
      return res.status(400).json({ status: "error", code: "vpa_invalid", message: "Enter your UPI ID — for example yourname@okhdfcbank." });
    }
    // The account the mandate debits is the investor's own, from their KYC — never the page's.
    const bank = (req.investor?.bank_accounts || []).find((b) => b?.account_number && b?.ifsc_code);
    if (!bank) {
      return res.status(400).json({ status: "error", code: "bank_missing", message: "Add your bank account in KYC before setting up auto-debit." });
    }

    const sipRegNo = String(body.sip_reg_no || "").trim();
    const gate = await this.gateOrder(req, null, { suitability: false });
    if (gate) return res.status(gate.httpStatus || 403).json(gate);
    const payload = buildMandateRegisterPayload({
      mode,
      vpa,
      amount: requested,
      bank,
      ucc: req.ucc,
      memberCode: this.memberCode,
      refId: req.consentRef,
    });
    const mandateRef = payload.data.mem_mandate_info.member_mandate_id;
    if (!(await recordConsents(req, [
      { type: "enach_authorization", order_id: mandateRef, max_limit: requested },
    ]))) {
      return res.status(503).json({ status: "error", code: "consent_unavailable",
        message: "Your authorisation could not be saved. No mandate has been submitted; please try again." });
    }
    const result = await this.callMandate("registerMandate", payload);
    const failure = result?._status ? String(result.message || "BSE did not register the mandate.") : bseFailure(result);
    if (failure) {
      // Filed as failed so the investor is told it needs another go (Laravel's notice).
      await recordMandate(req, { mode, status: "failed", amount: requested, sip_reg_no: sipRegNo || null, note: failure.slice(0, 300) });
      return res.status(502).json({ status: "error", code: "mandate_failed", message: failure });
    }

    const out = mandateOutcome(result);
    // BSE's own host is IP-whitelisted, so a link on it goes through our proxy — the payment
    // page's rule (getPaymentLink). Any other host (NPCI, the bank) is left as it is.
    const link = out.approval_link ? this.proxify(out.approval_link) : null;

    // §2 row 5 — the audit row carries what the investor actually authorised.
    await recordConsents(req, [
      { type: "enach_authorization", order_id: mandateRef, mandate_id: out.exch_mandate_id ? out.exch_mandate_id.slice(0, 64) : null, max_limit: requested, bank_ref: null },
    ]);

    let row = await recordMandate(req, {
      exch_mandate_id: out.exch_mandate_id,
      mode,
      status: out.state,
      amount: requested,
      approval_link: link,
      sip_reg_no: sipRegNo || null,
    });
    // Linked at BSE when the SIP is already visible there; otherwise /mandateStatus links it
    // on a later look. Laravel holds the pairing either way, so the SIP card can show it.
    let linked = false;
    if (sipRegNo && out.exch_mandate_id) {
      const sip = await this.loadOwnedSip(req, sipRegNo);
      if (sip) linked = await this.linkMandateToSip(req, row || { ...out, mode, amount: requested, status: out.state }, xspRegNo(sip));
    }

    return res.json({
      status: "success",
      data: {
        exch_mandate_id: out.exch_mandate_id,
        state: out.state,
        mode,
        approval_link: link,
        linked,
      },
    });
  };

  /**
   * Audit #11 — "Invest in this basket", in one click.
   *
   * One acknowledgement covers the basket; the amount is split by the basket's own weights
   * (from Laravel, never the browser); every leg is checked against its scheme's minimum, the
   * house floor, hidden schemes and "open for purchase" BEFORE anything is placed, so a basket
   * is never left half-bought because its third fund was always going to be refused. Then each
   * leg goes through purchaseNewOrder itself — the same door as a single-fund purchase, so
   * suitability, the approval threshold and the consent trail apply per fund exactly as they
   * would there. What BSE accepted is written to bse_orders here, server-side.
   */
  basketCheckout = async (req, res) => {
    const input = req.body?.data || req.body || {};
    const amount = Number(input.amount);
    if (!(amount > 0)) return res.status(400).json({ status: "error", message: "Enter the amount to invest." });

    // One acknowledgement for the whole basket — and checked once, up front, so a missing
    // tick refuses the basket rather than every leg one by one.
    const disclaimed = checkDisclaimers(input, { rms: cachedDistributor().rms });
    if (!disclaimed.ok) {
      return res.status(403).json({ status: "error", code: disclaimed.code, message: disclaimed.message, required: disclaimed.required });
    }

    const plan = await basketPlan(req, input.basket_id);
    if (!plan) return res.status(404).json({ status: "error", message: "Basket not found." });
    if (!plan.legs.length) return res.status(400).json({ status: "error", message: "This basket has no funds in it." });
    if (plan.legs.some((l) => l.asset_type !== "mutual_fund")) {
      return res.status(400).json({
        status: "error",
        message: "Only mutual funds can be bought through basket checkout. This basket also holds stocks or ETFs — buy those from their own pages.",
      });
    }

    const shares = splitByWeight(amount, plan.legs.map((l) => l.weight));
    const houseFloor = (await getLimits()).minLumpsum;
    const hidden = await getHidden();
    const legs = [];
    for (const [i, l] of plan.legs.entries()) {
      // An unreadable master is "not found", which refuses the basket — never a crash.
      const scheme = await this.lookupScheme(l.code).catch(() => null);
      const limits = checkSchemeLimits({ type: "p", amount: shares[i] }, scheme, houseFloor);
      legs.push({
        code: l.code,
        name: l.name || mapScheme(scheme || {}).name || l.code,
        weight: Number(l.weight),
        amount: shares[i],
        reason: isHidden(hidden, { scheme_bse_code: l.code }) ? "This scheme is not available for investment." : limits.ok ? null : limits.error,
      });
    }
    if (legs.some((l) => l.reason)) {
      return res.status(400).json({
        status: "error",
        code: "basket_leg_refused",
        message: "Nothing was placed — at least one fund cannot take its share of this amount.",
        data: { legs: legs.map((l) => ({ ...l, result: l.reason ? "refused" : "not_placed" })) },
      });
    }

    const results = [];
    for (const [i, l] of legs.entries()) {
      const mem = `${Date.now()}${String(i).padStart(2, "0")}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
      // The same order the single-fund page sends; UCC, member, demat and the AMFI block are
      // bound by purchaseNewOrder as for any other purchase.
      const order = {
        type: "p",
        mem_ord_ref_id: mem,
        scheme: l.code,
        amount: l.amount,
        cur: "INR",
        is_units: false,
        all_units: false,
        min_redeem_flag: false,
        folio: "",
        is_fresh: true,
        holder: [{ holder_rank: "1", email: req.investor?.email || "" }],
        kyc_passed: true,
        dpc: true,
        email: req.investor?.email || "",
      };
      const leg = { headers: req.headers, ip: req.ip, investor: req.investor, ucc: req.ucc, body: { data: { orders: [order], acknowledged: input.acknowledged } } };
      // A throw inside one leg must still answer, not leave the basket hanging with the legs
      // before it already placed and nobody told.
      const out = await new Promise((resolve) =>
        Promise.resolve(
          this.purchaseNewOrder(leg, {
            json: (data) => resolve(data),
            status: (code) => ({ json: (data) => resolve({ ...data, _status: code }) }),
          })
        ).catch((e) => resolve({ status: "error", message: `Not placed: ${e.message}`, _status: 500 }))
      );
      const id = out?.data?.items?.[0]?.id;
      if (!out?._status && !bseFailure(out) && id != null) {
        await recordOrder(req, {
          bse_order_id: id,
          mem_ord_ref_id: out.data.items[0].mem_ord_ref_id || mem,
          scheme_name: l.name,
          scheme_bse_code: l.code,
          inv_amo: l.amount,
          order_type: "purchase",
        });
        results.push({ ...l, result: "placed", order_id: id });
      } else if (out?.code === "ORDER_APPROVAL_REQUIRED") {
        results.push({ ...l, result: "held", reason: out.message });
      } else {
        results.push({ ...l, result: "refused", reason: out?.message || bseFailure(out) || "Not placed." });
      }
    }
    const count = (r) => results.filter((x) => x.result === r).length;
    return res.json({
      status: "success",
      data: { basket: plan.name || null, legs: results, placed: count("placed"), held: count("held"), refused: count("refused") },
    });
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
module.exports.buildXspListPayload = buildXspListPayload;
module.exports.scopeXspResponse = scopeXspResponse;
module.exports.bseMessages = bseMessages;
