const { Router } = require('express');
const { signCloudinaryParams } = require('../utils/cloudinarySig');
const router = Router();

router.post('/cloudinary/sign', (req, res) => {
  try { return res.json(signCloudinaryParams(req.body || {})); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

module.exports = router;
