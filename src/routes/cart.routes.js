const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

/**
 * GET /api/cart
 * Returns the customer's smart cart grouped by business.
 */
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ci.id, ci.quantity, ci.selected_combo, ci.product_id, ci.business_id,
              p.name, p.price, p.promo_price, p.promo_ends_at, p.image_url, p.item_type,
              p.stock_quantity, p.is_available, p.unit_label,
              b.name AS business_name, b.latitude AS business_lat, b.longitude AS business_lng,
              b.delivery_available, b.pickup_available
       FROM cart_items ci
       JOIN products_services p ON p.id = ci.product_id
       JOIN businesses b ON b.id = ci.business_id
       WHERE ci.user_id = $1
       ORDER BY ci.created_at ASC`,
      [req.user.id]
    );
    return res.json({ items: rows });
  } catch (error) {
    console.error('[Cart Get] Error:', error);
    return res.status(500).json({ message: 'Failed to load cart.' });
  }
});

/**
 * POST /api/cart
 */
router.post('/', authorize('customer'), async (req, res) => {
  try {
    const { productId, quantity = 1, selectedCombo = null } = req.body;
    if (!productId) return res.status(400).json({ message: 'productId is required.' });

    const prodRes = await db.query(
      `SELECT p.*, b.approval_status FROM products_services p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.id = $1`,
      [productId]
    );
    if (prodRes.rows.length === 0 || prodRes.rows[0].approval_status !== 'approved') {
      return res.status(404).json({ message: 'Product not found.' });
    }
    const prod = prodRes.rows[0];
    if (!prod.is_available || (prod.item_type === 'product' && prod.stock_quantity < Number(quantity))) {
      return res.status(400).json({ message: 'Item is out of stock or insufficient quantity.' });
    }

    const { rows } = await db.query(
      `INSERT INTO cart_items (user_id, product_id, business_id, quantity, selected_combo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity,
                     selected_combo = COALESCE(EXCLUDED.selected_combo, cart_items.selected_combo),
                     updated_at = NOW()
       RETURNING *`,
      [req.user.id, productId, prod.business_id, Number(quantity), selectedCombo ? JSON.stringify(selectedCombo) : null]
    );

    // Log AI implicit behavior
    await db.query(
      `INSERT INTO user_behaviors (user_id, product_id, business_id, action_type, weight)
       VALUES ($1, $2, $3, 'cart_add', 3)`,
      [req.user.id, productId, prod.business_id]
    );

    return res.status(201).json({ item: rows[0], message: 'Added to smart cart.' });
  } catch (error) {
    console.error('[Cart Add] Error:', error);
    return res.status(500).json({ message: 'Failed to add item to cart.' });
  }
});

/**
 * PUT /api/cart/:id
 */
router.put('/:id', authorize('customer'), async (req, res) => {
  const { quantity } = req.body;
  if (!quantity || Number(quantity) < 1) {
    await db.query('DELETE FROM cart_items WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    return res.json({ message: 'Removed from cart.' });
  }

  const { rows } = await db.query(
    'UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
    [Number(quantity), req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ message: 'Cart item not found.' });
  return res.json({ item: rows[0] });
});

/**
 * DELETE /api/cart/:id
 */
router.delete('/:id', authorize('customer'), async (req, res) => {
  await db.query('DELETE FROM cart_items WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  return res.json({ message: 'Item removed from cart.' });
});

/**
 * DELETE /api/cart
 */
router.delete('/', authorize('customer'), async (req, res) => {
  await db.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.id]);
  return res.json({ message: 'Cart cleared.' });
});

/**
 * Favorites endpoints
 */
router.get('/favorites', async (req, res) => {
  const { rows } = await db.query(
    `SELECT f.id, f.business_id, f.product_id,
            b.name AS business_name, b.category AS business_category, b.address AS business_address,
            p.name AS product_name, p.price AS product_price, p.image_url AS product_image
     FROM favorites f
     LEFT JOIN businesses b ON b.id = f.business_id
     LEFT JOIN products_services p ON p.id = f.product_id
     WHERE f.user_id = $1
     ORDER BY f.created_at DESC`,
    [req.user.id]
  );
  return res.json({ favorites: rows });
});

router.post('/favorites/toggle', async (req, res) => {
  const { businessId, productId } = req.body;
  if (!businessId && !productId) {
    return res.status(400).json({ message: 'businessId or productId is required.' });
  }

  if (businessId) {
    const existing = await db.query(
      'SELECT id FROM favorites WHERE user_id = $1 AND business_id = $2',
      [req.user.id, businessId]
    );
    if (existing.rows.length > 0) {
      await db.query('DELETE FROM favorites WHERE id = $1', [existing.rows[0].id]);
      return res.json({ saved: false });
    }
    await db.query('INSERT INTO favorites (user_id, business_id) VALUES ($1, $2)', [req.user.id, businessId]);
    return res.json({ saved: true });
  }

  const existing = await db.query(
    'SELECT id FROM favorites WHERE user_id = $1 AND product_id = $2',
    [req.user.id, productId]
  );
  if (existing.rows.length > 0) {
    await db.query('DELETE FROM favorites WHERE id = $1', [existing.rows[0].id]);
    return res.json({ saved: false });
  }
  await db.query('INSERT INTO favorites (user_id, product_id) VALUES ($1, $2)', [req.user.id, productId]);
  return res.json({ saved: true });
});

module.exports = router;
