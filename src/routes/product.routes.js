const express = require('express');
const db = require('../config/db');
const { authenticate, optionalAuthenticate, authorize } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const router = express.Router();

const uploadProductImages = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: 6 },
]);

function extractUploadedImages(req) {
  const files = [
    ...(req.files?.image || []),
    ...(req.files?.images || []),
  ];
  return files.map((file) => `/uploads/${file.filename}`);
}

/**
 * GET /api/products/my (Vendor's own catalog)
 */
router.get('/my', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const bizRes = await db.query('SELECT id FROM businesses WHERE owner_id = $1', [req.user.id]);
    if (bizRes.rows.length === 0) return res.status(404).json({ message: 'Business not found.' });

    const { rows } = await db.query(
      'SELECT * FROM products_services WHERE business_id = $1 ORDER BY created_at DESC',
      [bizRes.rows[0].id]
    );
    return res.json({ items: rows });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch products.' });
  }
});

/**
 * POST /api/products (Vendor creates product or service)
 */
router.post('/', authenticate, authorize('vendor'), uploadProductImages, async (req, res) => {
  try {
    const bizRes = await db.query('SELECT id FROM businesses WHERE owner_id = $1', [req.user.id]);
    if (bizRes.rows.length === 0) return res.status(404).json({ message: 'Business not found.' });
    const businessId = bizRes.rows[0].id;

    const {
      itemType = 'product',
      name,
      description,
      category,
      price,
      promoPrice,
      promoEndsAt,
      billingType = 'unit',
      unitLabel = 'item',
      stockQuantity = 0,
      lowStockThreshold = 5,
      isAvailable = true,
      comboOptions,
    } = req.body;

    if (!name || price == null) {
      return res.status(400).json({ message: 'Name and price are required.' });
    }

    const uploadedImages = extractUploadedImages(req);
    const imageUrl = uploadedImages[0] || null;
    const parsedCombos = comboOptions
      ? typeof comboOptions === 'string'
        ? JSON.parse(comboOptions)
        : comboOptions
      : [];

    const { rows } = await db.query(
      `INSERT INTO products_services (
        business_id, item_type, name, description, category, price, promo_price, promo_ends_at,
        billing_type, unit_label, stock_quantity, low_stock_threshold, is_available, combo_options, image_url, images
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        businessId,
        itemType,
        name.trim(),
        description?.trim() || null,
        category?.trim() || 'General',
        Number(price),
        promoPrice !== undefined && promoPrice !== '' && promoPrice !== null ? Number(promoPrice) : null,
        promoEndsAt || null,
        billingType,
        unitLabel,
        Number(stockQuantity) || 0,
        Number(lowStockThreshold) || 5,
        isAvailable === true || isAvailable === 'true',
        JSON.stringify(parsedCombos),
        imageUrl,
        JSON.stringify(uploadedImages),
      ]
    );

    return res.status(201).json({ item: rows[0], message: 'Item added successfully.' });
  } catch (error) {
    console.error('[Create Product] Error:', error);
    return res.status(500).json({ message: 'Failed to create product/service.' });
  }
});

/**
 * PUT /api/products/:id (Vendor updates product/service)
 */
router.put('/:id', authenticate, authorize('vendor'), uploadProductImages, async (req, res) => {
  try {
    const bizRes = await db.query('SELECT id FROM businesses WHERE owner_id = $1', [req.user.id]);
    if (bizRes.rows.length === 0) return res.status(404).json({ message: 'Business not found.' });
    const businessId = bizRes.rows[0].id;

    const {
      name,
      description,
      category,
      price,
      promoPrice,
      promoEndsAt,
      billingType,
      unitLabel,
      stockQuantity,
      lowStockThreshold,
      isAvailable,
      comboOptions,
    } = req.body;

    const uploadedImages = extractUploadedImages(req);
    const imageUrl = uploadedImages[0] || null;
    const imagesJson = uploadedImages.length > 0 ? JSON.stringify(uploadedImages) : null;
    const parsedCombos = comboOptions
      ? typeof comboOptions === 'string'
        ? JSON.parse(comboOptions)
        : comboOptions
      : null;

    const { rows } = await db.query(
      `UPDATE products_services SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        category = COALESCE($3, category),
        price = COALESCE($4, price),
        promo_price = $5,
        promo_ends_at = $6,
        billing_type = COALESCE($7, billing_type),
        unit_label = COALESCE($8, unit_label),
        stock_quantity = COALESCE($9, stock_quantity),
        low_stock_threshold = COALESCE($10, low_stock_threshold),
        is_available = COALESCE($11, is_available),
        combo_options = COALESCE($12, combo_options),
        image_url = COALESCE($13, image_url),
        images = COALESCE($14, images),
        updated_at = NOW()
       WHERE id = $15 AND business_id = $16
       RETURNING *`,
      [
        name?.trim() || null,
        description?.trim() || null,
        category?.trim() || null,
        price != null ? Number(price) : null,
        promoPrice !== undefined && promoPrice !== '' && promoPrice !== null ? Number(promoPrice) : null,
        promoEndsAt || null,
        billingType || null,
        unitLabel || null,
        stockQuantity != null ? Number(stockQuantity) : null,
        lowStockThreshold != null ? Number(lowStockThreshold) : null,
        isAvailable !== undefined ? isAvailable === true || isAvailable === 'true' : null,
        parsedCombos ? JSON.stringify(parsedCombos) : null,
        imageUrl,
        imagesJson,
        req.params.id,
        businessId,
      ]
    );

    if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
    return res.json({ item: rows[0], message: 'Item updated.' });
  } catch (error) {
    console.error('[Update Product] Error:', error);
    return res.status(500).json({ message: 'Failed to update item.' });
  }
});

/**
 * DELETE /api/products/:id
 */
router.delete('/:id', authenticate, authorize('vendor'), async (req, res) => {
  const bizRes = await db.query('SELECT id FROM businesses WHERE owner_id = $1', [req.user.id]);
  if (bizRes.rows.length === 0) return res.status(404).json({ message: 'Business not found.' });

  const { rowCount } = await db.query(
    'DELETE FROM products_services WHERE id = $1 AND business_id = $2',
    [req.params.id, bizRes.rows[0].id]
  );
  if (rowCount === 0) return res.status(404).json({ message: 'Item not found.' });
  return res.json({ message: 'Item deleted.' });
});

/**
 * POST /api/products/:id/track
 * Implicit behavior tracking for local AI recommendations (view, click, cart_add, purchase)
 */
router.post('/:id/track', optionalAuthenticate, async (req, res) => {
  try {
    const { actionType = 'view', businessId } = req.body;
    const weights = { view: 1, click: 2, cart_add: 3, purchase: 5 };
    const weight = weights[actionType] || 1;

    await db.query(
      `INSERT INTO user_behaviors (user_id, product_id, business_id, action_type, weight)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user?.id || null, req.params.id, businessId || null, actionType, weight]
    );

    return res.json({ tracked: true });
  } catch {
    return res.json({ tracked: false });
  }
});

module.exports = router;

