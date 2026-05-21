const express = require("express");
const allRoutes = require("../all-routes/AllRoutes");

const router = express.Router();

// Mount individual routes
router.use("/", allRoutes); 

module.exports = router;
