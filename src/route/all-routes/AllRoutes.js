const StarMFController = require("../../controllers/StarMFController");
const { requireInvestor, requireMatchingUcc } = require("../../middleware/requireInvestor");
const router = require("express").Router();

const auth = [requireInvestor, requireMatchingUcc];

// UCC
router.post("/v2/add_ucc", requireInvestor, StarMFController.addUcc);
router.post("/getAllUcc", requireInvestor, StarMFController.getAllUcc);
router.post("/getparticularucc", requireInvestor, StarMFController.getParticularUcc);
router.post("/createPhysicalUcc", requireInvestor, StarMFController.createPhysicalUcc);
router.post("/createDematUcc", requireInvestor, StarMFController.createDematUcc);
router.post("/createBothUcc", requireInvestor, StarMFController.createBothUcc);
router.post("/updateUccAddress", requireInvestor, StarMFController.updateUccAddress);
router.post("/updateUccProfile", requireInvestor, StarMFController.updateUccProfile);
router.post("/updateUccUpdateBankData", requireInvestor, StarMFController.updateUccUpdateBankData);
router.post("/deactivateUcc", requireInvestor, StarMFController.deactivateUcc);

// SIP / XSP
router.post("/xspRegister", ...auth, StarMFController.xspRegister);
router.post("/getXsp", ...auth, StarMFController.getXsp);
router.post("/pauseXsp", ...auth, StarMFController.pauseXsp);
router.post("/cancelXsp", ...auth, StarMFController.cancelXsp);
router.post("/getAllXsp", ...auth, StarMFController.getAllXsp);
router.post("/topupXsp", ...auth, StarMFController.topupXsp);
router.post("/resumeXsp", ...auth, StarMFController.resumeXsp);
router.post("/getXspTrxnHistory", ...auth, StarMFController.getXspTrxnHistory);

// Orders
router.post("/purchaseNewOrder", ...auth, StarMFController.purchaseNewOrder);
router.post("/updatePurchaseOrder", ...auth, StarMFController.updatePurchaseOrder);
router.post("/getAllOrders", ...auth, StarMFController.getAllOrders);
router.post("/getOrder", ...auth, StarMFController.getOrder);
router.post("/getClientPortfolio", requireInvestor, StarMFController.getClientPortfolio);
router.post("/cancelPurchaseOrder", ...auth, StarMFController.cancelPurchaseOrder);

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
router.post("/uploadMis", StarMFController.uploadMis);
router.post("/getMisDetails", StarMFController.getMisDetails);

// Schemes & NAV
router.post("/master-scheme-list", StarMFController.getSchemeMasterList);
router.post("/scheme-details", StarMFController.getSchemeDetails);
router.post("/getNavMasterList", StarMFController.getNavMasterList);
router.post("/getSchemeReturns", StarMFController.getSchemeReturns);

// NFT
router.post("/nftBankAccountChange", StarMFController.nftBankAccountChange);
router.post("/nftNomineeChange", StarMFController.nftNomineeChange);
router.post("/nftContactChange", StarMFController.nftContactChange);

// 2FA
router.post("/get2FAUccNom", StarMFController.get2FAUccNom);
router.post("/get2FAUccElog", StarMFController.get2FAUccElog);
router.post("/get2FAVerifyMandateCancel", StarMFController.get2FAVerifyMandateCancel);
router.post("/get2FAVerifySxpReg", StarMFController.get2FAVerifySxpReg);
router.post("/get2FAVerifyOrderCancel", StarMFController.get2FAVerifyOrderCancel);

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

router.get("/test-api", StarMFController.testAPI);

module.exports = router;
