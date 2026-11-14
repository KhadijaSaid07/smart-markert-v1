const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, authorize('customer'));

/**
 * GET /api/favorites
 * List customer's saved favorite businesses and products.
 */
router.get('/', async (req, res) => {
  try {
    const bizRes = await db.query(
      `SELECT f.id AS favorite_id, b.id, b.name, b.category, b.description, b.address, b.banner_url, b.is_open
       FROM favorites f
       JOIN businesses b ON b.id = f.business_id
       WHERE f.user_id = $1 AND f.business_id IS NOT NULL
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );

    const prodRes = await db.query(
      `SELECT f.id AS favorite_id, p.id, p.business_id, p.name, p.category, p.price, p.promo_price,
              p.image_url, p.item_type, b.name AS business_name
       FROM favorites f
       JOIN products_services p ON p.id = f.product_id
       JOIN businesses b ON b.id = p.business_id
       WHERE f.user_id = $1 AND f.product_id IS NOT NULL
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );

    return res.json({
      businesses: bizRes.rows,
      products: prodRes.rows,
    });
  } catch (error) {
    console.error('[Favorites GET] Error:', error);
    return res.status(500).json({ message: 'Failed to load favorites.' });
  }
});

/**
 * POST /api/favorites
 * Save a business or product to favorites.
 */
router.post('/', async (req, res) => {
  try {
    const { businessId, productId } = req.body;
    if (!businessId && !productId) {
      return res.status(400).json({ message: 'businessId or productId is required.' });
    }

    if (businessId) {
      await db.query(
        'INSERT INTO favorites (user_id, business_id) VALUES ($1, $2) ON CONFLICT (user_id, business_id) DO NOTHING',
        [req.user.id, businessId]
      );
    }

    if (productId) {
      await db.query(
        'INSERT INTO favorites (user_id, product_id) VALUES ($1, $2) ON CONFLICT (user_id, product_id) DO NOTHING',
        [req.user.id, productId]
      );
    }

    return res.status(201).json({ message: 'Saved to favorites.' });
  } catch (error) {
    console.error('[Favorites POST] Error:', error);
    return res.status(500).json({ message: 'Failed to save favorite.' });
  }
});

/**
 * DELETE /api/favorites/:id
 * Remove a favorite by favorite row id (or business/product id).
 */
router.delete('/:id', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM favorites WHERE user_id = $1 AND (id = $2 OR business_id = $2 OR product_id = $2)',
      [req.user.id, req.params.id]
    );
    return res.json({ message: 'Removed from favorites.' });
  } catch (error) {
    console.error('[Favorites DELETE] Error:', error);
    return res.status(500).json({ message: 'Failed to remove favorite.' });
  }
});

module.exports = router;

