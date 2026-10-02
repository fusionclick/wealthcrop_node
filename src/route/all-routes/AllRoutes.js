const StarMFController = require("../../controllers/StarMFController");
const { requireInvestor, requireMatchingUcc, requireLiveBse } = require("../../middleware/requireInvestor");
const router = require("express").Router();
// Stateless public calculation; no investor book or credentials are exposed.
router.post('/allocation-review', async (req, res, next) => {
  try {
    const { RISK_PROFILES, LIFE_STAGES, reviewedPlan } = await import('../../mf/allocation.mjs');
    const input = req.body || {};
    if (!RISK_PROFILES.includes(input.risk) || !LIFE_STAGES.some(([id]) => id === input.lifeStage)
      || !Number.isFinite(input.horizonYears) || input.horizonYears < 1 || input.horizonYears > 60
      || !Number.isFinite(input.monthlyAmount) || input.monthlyAmount < 0 || input.monthlyAmount > 1e9) {
      return res.status(422).json({ status: false, message: 'Invalid allocation inputs.' });
    }
    return res.json({ status: true, data: reviewedPlan(input) });
  } catch (error) { next(error); }
});

const auth = [requireInvestor, requireMatchingUcc];
const exchangeActions = new Set([
  "/v2/add_ucc", "/xspRegister", "/pauseXsp", "/cancelXsp", "/topupXsp", "/resumeXsp", "/modifyXsp",
  "/purchaseNewOrder", "/updatePurchaseOrder", "/cancelPurchaseOrder", "/basketCheckout",
  "/get-payment-link", "/sendPaymentInfo", "/uploadMis",
  "/nftBankAccountChange", "/nftNomineeChange", "/nftContactChange",
  "/get2FAUccNom", "/get2FAUccElog", "/get2FAVerifyMandateCancel", "/get2FAVerifySxpReg", "/get2FAVerifyOrderCancel",
  "/registerMandate", "/registerMandateUPI", "/registerMandateEnach", "/registerMandateNach",
  "/cancelMandate", "/linkMandate", "/mandateDelink", "/updateMandate", "/mandate_register/upi-autopay",
]);
router.use((req, res, next) => exchangeActions.has(req.path) ? requireLiveBse(req, res, next) : next());
router.post('/nav-quotes', async (req, res, next) => {
  const isins = req.body?.isins;
  if (!Array.isArray(isins) || !isins.length || isins.length > 20 || !isins.every((isin) => /^IN[A-Z0-9]{10}$/.test(isin))) {
    return res.status(422).json({ status: false, message: 'Supply 1–20 valid scheme ISINs.' });
  }
  try {
    const snapshot = await require('../../mf/navStore').getNavs(StarMFController);
    return res.json({ status: true, data: Object.fromEntries(isins.map((isin) => [isin, snapshot.navs[isin] || null])) });
  } catch (error) { next(error); }
});

// UCC
router.post("/v2/add_ucc", requireInvestor, StarMFController.addUcc);
// getAllUcc, getparticularucc, create*/update*/deactivateUcc and getAllOrders are gone: no
// screen called them, and any logged-in investor could use them to list every investor's
// UCC record, read another's, or send the member's demo templates (deactivate included) to BSE.
// KYC = BSE's ucc_status. Laravel calls this (bearer forwarded) and writes kyc_status itself.
router.post("/kyc/bse-status", ...auth, StarMFController.kycBseStatus);

// SIP / XSP
router.post("/xspRegister", ...auth, StarMFController.xspRegister);
router.post("/getXsp", ...auth, StarMFController.getXsp);
router.post("/pauseXsp", ...auth, StarMFController.pauseXsp);
router.post("/cancelXsp", ...auth, StarMFController.cancelXsp);
router.post("/getAllXsp", ...auth, StarMFController.getAllXsp);
router.post("/topupXsp", ...auth, StarMFController.topupXsp);
router.post("/resumeXsp", ...auth, StarMFController.resumeXsp);
router.post("/getXspTrxnHistory", ...auth, StarMFController.getXspTrxnHistory);
// BSE has no sxp_update — modify is register-then-cancel, in that order, server-side.
router.post("/modifyXsp", ...auth, StarMFController.modifyXsp);

// Ticket 16: read a CAMS/KFintech statement and hand back the holdings in it. Nothing is
// stored here — the rows go to Laravel's external-portfolio table, the same one the
// "Add Fund" form writes to, so requireInvestor (not ...auth) is the right gate: there is
// no UCC in a CAS, and an investor with no BSE account can still import one.
router.post("/cas/import", requireInvestor, StarMFController.casImport);

// Orders
// The statutory text the checkout screens render, and which of them must be ticked. Public:
// it is a regulatory notice, and gating it behind a login would only mean showing it later.
router.get("/disclaimers", StarMFController.disclaimers);
router.post("/purchaseNewOrder", ...auth, StarMFController.purchaseNewOrder);
router.post("/updatePurchaseOrder", ...auth, StarMFController.updatePurchaseOrder);
router.post("/getOrder", ...auth, StarMFController.getOrder);
router.post("/getClientPortfolio", requireInvestor, StarMFController.getClientPortfolio);
// Same BSE endpoint as getClientPortfolio, opposite intent: every order, every status.
router.post("/orderHistory", requireInvestor, StarMFController.orderHistory);
// Audit #62 — volatility, Sharpe, drawdown, VaR and beta for the investor's whole portfolio.
router.post("/portfolio-metrics", requireInvestor, require("../../mf/portfolioMetrics").portfolioMetricsHandler);
router.post("/cancelPurchaseOrder", ...auth, StarMFController.cancelPurchaseOrder);
// Audit #11 — one lump sum across a basket's funds, each leg through /purchaseNewOrder's gates.
router.post("/basketCheckout", ...auth, StarMFController.basketCheckout);

// Payments
router.post("/listPaymentDetail", ...auth, StarMFController.listPaymentDetail);
router.post("/getPaymentDetail", ...auth, StarMFController.getPaymentDetail);
router.post("/get-payment-link", ...auth, StarMFController.getPaymentLink);
// ponytail: BSE demo host sirf whitelisted IP se khulta hai, user ka browser block hota
// hai — is liye page hamare (whitelisted) server se guzarta hai. Auth yahan nahi lag
// sakti: page ke apne assets/redirects Authorization header nahi bhejte. URL ka
// pg_view_object token hi credential hai, BSE ne wahi diya hai.
router.all("/pg/*", StarMFController.proxyPaymentPage);
router.post("/payment/callback", StarMFController.paymentCallback);
router.post("/getExchPgService", ...auth, StarMFController.getExchPgService);
router.post("/sendPaymentInfo", ...auth, StarMFController.sendPaymentInfo);

// MIS
// ponytail: payment reporting hai — baaki Payments block ki tarah ...auth.
router.post("/uploadMis", ...auth, StarMFController.uploadMis);
router.post("/getMisDetails", ...auth, StarMFController.getMisDetails);

// Schemes & NAV
router.post("/master-scheme-list", StarMFController.getSchemeMasterList);
router.post("/scheme-details", StarMFController.getSchemeDetails);
// Public like the rest of the catalogue — comparing funds needs no account, and gating it
// would put the compare tool behind a login that /master-scheme-list does not require.
router.post("/scheme-compare", StarMFController.compareSchemes);
router.post("/getNavMasterList", StarMFController.getNavMasterList);
router.post("/getSchemeReturns", StarMFController.getSchemeReturns);

// NFT
// ponytail: ye investor ka bank/nominee/contact BSE par badalte hain — file ke har
// dusre mutating route ki tarah ...auth. Handler filhaal req.body padhta hi nahi
// (controller par note), guard phir bhi ab lagta hai taake wire hone par UCC
// binding pehle se maujood ho.
router.post("/nftBankAccountChange", ...auth, StarMFController.nftBankAccountChange);
router.post("/nftNomineeChange", ...auth, StarMFController.nftNomineeChange);
router.post("/nftContactChange", ...auth, StarMFController.nftContactChange);

// 2FA
router.post("/get2FAUccNom", requireInvestor, StarMFController.get2FAUccNom);
router.post("/get2FAUccElog", requireInvestor, StarMFController.get2FAUccElog);
// ponytail: ye 2FA link wahi action kholta hai jo khud ...auth ke peeche hai
// (cancelMandate / xspRegister / cancelPurchaseOrder) — link bhi utna hi guarded ho.
// UccNom/UccElog upar sirf requireInvestor par isliye hain ke wo apna UCC
// req.investor se khud nikalte hain; ye teeno kuch nahi nikalte.
router.post("/get2FAVerifyMandateCancel", ...auth, StarMFController.get2FAVerifyMandateCancel);
router.post("/get2FAVerifySxpReg", ...auth, StarMFController.get2FAVerifySxpReg);
router.post("/get2FAVerifyOrderCancel", ...auth, StarMFController.get2FAVerifyOrderCancel);

// Mandates
router.post("/registerMandate", ...auth, StarMFController.registerMandate);
router.post("/registerMandateUPI", ...auth, StarMFController.registerMandateUPI);
router.post("/registerMandateEnach", ...auth, StarMFController.registerMandateEnach);
router.post("/registerMandateNach", ...auth, StarMFController.registerMandateNach);
router.post("/getMandate", ...auth, StarMFController.getMandate);
router.post("/getAllMandate", ...auth, StarMFController.getAllMandate);
router.post("/cancelMandate", ...auth, StarMFController.cancelMandate);
router.post("/linkMandate", ...auth, StarMFController.linkMandate);
router.post("/mandateDelink", ...auth, StarMFController.mandateDelink);
router.post("/updateMandate", ...auth, StarMFController.updateMandate);
router.post("/mandate_register/upi-autopay", ...auth, StarMFController.mandateRegisterUpiAutoPay);
// Audit #22 — the investor's mandates with BSE's current status (no cron; read on view).
router.post("/mandateStatus", ...auth, StarMFController.mandateStatus);

router.get("/test-api", StarMFController.testAPI);

module.exports = router;
