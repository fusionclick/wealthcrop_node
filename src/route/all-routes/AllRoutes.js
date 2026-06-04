const StarMFController = require("../../controllers/StarMFController");
const router = require("express").Router();

// router.post("/", StarMFController.login);
router.post("/login", StarMFController.loginRequest);
router.post("/api/login", StarMFController.login);
router.post("/v2/add_ucc", StarMFController.addUcc);
router.post("/getAllUcc", StarMFController.getAllUcc);
router.post("/getparticularucc", StarMFController.getParticularUcc);
router.post("/createPhysicalUcc", StarMFController.createPhysicalUcc);
router.post("/createDematUcc", StarMFController.createDematUcc);
router.post("/createBothUcc", StarMFController.createBothUcc);
router.post("/updateUccAddress", StarMFController.updateUccAddress);
router.post("/updateUccProfile", StarMFController.updateUccProfile);
router.post("/updateUccUpdateBankData", StarMFController.updateUccUpdateBankData);
router.post("/deactivateUcc", StarMFController.deactivateUcc);
router.post("/xspRegister", StarMFController.xspRegister);
router.post("/getXsp", StarMFController.getXsp);
router.post("/pauseXsp", StarMFController.pauseXsp);
router.post("/cancelXsp", StarMFController.cancelXsp);
router.post("/getAllXsp", StarMFController.getAllXsp);
router.post("/topupXsp", StarMFController.topupXsp);
router.post("/resumeXsp", StarMFController.resumeXsp);
router.post("/getXspTrxnHistory", StarMFController.getXspTrxnHistory);
router.post("/api/purchaseNewOrder", StarMFController.purchaseNewOrder);
router.post("/updatePurchaseOrder", StarMFController.updatePurchaseOrder);
router.post("/api/getAllOrders", StarMFController.getAllOrders);
router.post("/api/getOrder", StarMFController.getOrder);
router.post("/cancelPurchaseOrder", StarMFController.cancelPurchaseOrder);
router.post("/listPaymentDetail", StarMFController.listPaymentDetail);
router.post("/getPaymentDetail", StarMFController.getPaymentDetail);
router.post("/uploadMis", StarMFController.uploadMis);
router.post("/getMisDetails", StarMFController.getMisDetails);
router.post("/api/master-scheme-list", StarMFController.getSchemeMasterList);
router.post("/api/scheme-details", StarMFController.getSchemeDetails);
router.post("/nftBankAccountChange", StarMFController.nftBankAccountChange);
router.post("/nftNomineeChange", StarMFController.nftNomineeChange);
router.post("/nftContactChange", StarMFController.nftContactChange);

// Get 2FA Link Routes
router.post("/get2FAUccNom", StarMFController.get2FAUccNom);
router.post("/get2FAUccElog", StarMFController.get2FAUccElog);
router.post("/get2FAVerifyMandateCancel", StarMFController.get2FAVerifyMandateCancel);
router.post("/get2FAVerifySxpReg", StarMFController.get2FAVerifySxpReg);
router.post("/get2FAVerifyOrderCancel", StarMFController.get2FAVerifyOrderCancel);

// Mandate Routes
router.post("/registerMandate", StarMFController.registerMandate);
router.post("/registerMandateUPI", StarMFController.registerMandateUPI);
router.post("/registerMandateEnach", StarMFController.registerMandateEnach);
router.post("/registerMandateNach", StarMFController.registerMandateNach);
router.post("/getMandate", StarMFController.getMandate);
router.post("/getAllMandate", StarMFController.getAllMandate);
router.post("/cancelMandate", StarMFController.cancelMandate);
router.post("/linkMandate", StarMFController.linkMandate);
router.post("/mandateDelink", StarMFController.mandateDelink);
router.post("/updateMandate", StarMFController.updateMandate);
router.post("/getExchPgService", StarMFController.getExchPgService);
router.post("/sendPaymentInfo", StarMFController.sendPaymentInfo);


//Nav Routes
router.post("/getNavMasterList", StarMFController.getNavMasterList);
router.post("/getSchemeReturns", StarMFController.getSchemeReturns);

// Get payment link for orders
router.post("/get-payment-link", StarMFController.getPaymentLink);
router.get("/test-api", StarMFController.testAPI);

module.exports = router;
