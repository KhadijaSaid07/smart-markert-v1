const express = require('express');
const { optionalAuthenticate } = require('../middleware/auth');
const {
  getPersonalizedRecommendations,
  getFrequentlyBoughtTogether,
  predictEtaMinutes,
} = require('../services/aiService');

const router = express.Router();

/**
 * GET /api/ai/recommendations
 */
router.get('/recommendations', optionalAuthenticate, async (req, res) => {
  try {
    const limit = Math.min(20, Number(req.query.limit) || 8);
    const items = await getPersonalizedRecommendations(req.user?.id || null, limit);
    return res.json({ recommendations: items });
  } catch (error) {
    console.error('[AI Recommendations] Error:', error);
    return res.status(500).json({ message: 'Failed to load recommendations.' });
  }
});

/**
 * GET /api/ai/frequently-bought-together/:productId
 */
router.get('/frequently-bought-together/:productId', async (req, res) => {
  try {
    const items = await getFrequentlyBoughtTogether(req.params.productId, 4);
    return res.json({ items });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load related items.' });
  }
});

/**
 * GET /api/ai/eta?distanceKm=3.5
 */
router.get('/eta', (req, res) => {
  const distanceKm = Number(req.query.distanceKm) || 2.5;
  const result = predictEtaMinutes(distanceKm, new Date());
  return res.json(result);
});

module.exports = router;

