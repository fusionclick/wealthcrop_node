const express = require('express');
const router = express.Router();
const nseController = require('../../controllers/NseMFController');

// NSE NMF II Routes
router.post('/login', (req, res) => nseController.login(req, res));
router.post('/ucc/create', (req, res) => nseController.createUCC(req, res));

module.exports = router;
