const express = require('express');
const db = require('../config/db');
const { authenticate, optionalAuthenticate, authorize } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { haversineDistanceKm } = require('../utils/geo');

const router = express.Router();

/**
 * GET /api/businesses
 * Public proximity-based discovery for approved businesses.
 */
router.get('/', optionalAuthenticate, async (req, res) => {
  try {
    const { lat, lng, radiusKm = 25, category, search } = req.query;
    const params = [];
    const conditions = ["b.approval_status = 'approved'"];

    if (category && category !== 'All') {
      params.push(category);
      conditions.push(`b.category = $${params.length}`);
    }

    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      conditions.push(
        `(LOWER(b.name) LIKE $${params.length} OR LOWER(COALESCE(b.description, '')) LIKE $${params.length} OR LOWER(b.category) LIKE $${params.length})`
      );
    }

    const { rows } = await db.query(
      `SELECT b.*,
              (SELECT COUNT(*)::int FROM products_services p WHERE p.business_id = b.id AND p.is_available = TRUE) AS item_count
       FROM businesses b
       WHERE ${conditions.join(' AND ')}
       ORDER BY b.created_at DESC`,
      params
    );

    const userLat = lat != null ? Number(lat) : req.user?.latitude;
    const userLng = lng != null ? Number(lng) : req.user?.longitude;

    let enriched = rows.map((b) => {
      const distanceKm = haversineDistanceKm(userLat, userLng, b.latitude, b.longitude);
      return { ...b, distance_km: distanceKm };
    });

    if (userLat != null && userLng != null && !Number.isNaN(userLat) && !Number.isNaN(userLng)) {
      if (lat != null && lng != null && req.query.radiusKm != null) {
        const maxRadius = Number(radiusKm) || 25;
        enriched = enriched.filter((b) => b.distance_km === null || b.distance_km <= maxRadius);
      }
      enriched = enriched.sort((a, b) => (a.distance_km ?? 9999) - (b.distance_km ?? 9999));
    }

    return res.json({ businesses: enriched });
  } catch (error) {
    console.error('[Businesses List] Error:', error);
    return res.status(500).json({ message: 'Failed to load businesses.' });
  }
});

/**
 * GET /api/businesses/my/storefront (Vendor only)
 */
router.get('/my/storefront', authenticate, authorize('vendor'), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM businesses WHERE owner_id = $1', [req.user.id]);
  if (rows.length === 0) {
    return res.status(404).json({ message: 'Business storefront not found.' });
  }
  return res.json({ business: rows[0] });
});

/**
 * PUT /api/businesses/my/storefront (Vendor only)
 */
router.put(
  '/my/storefront',
  authenticate,
  authorize('vendor'),
  upload.single('banner'),
  async (req, res) => {
    try {
      const {
        name,
        category,
        description,
        phone,
        email,
        address,
        latitude,
        longitude,
        openingHours,
        deliveryAvailable,
        pickupAvailable,
        isOpen,
      } = req.body;

      const bannerUrl = req.file ? `/uploads/${req.file.filename}` : null;
      let parsedHours = null;
      if (openingHours) {
        parsedHours = typeof openingHours === 'string' ? JSON.parse(openingHours) : openingHours;
      }

      const { rows } = await db.query(
        `UPDATE businesses SET
          name = COALESCE($1, name),
          category = COALESCE($2, category),
          description = COALESCE($3, description),
          phone = COALESCE($4, phone),
          email = COALESCE($5, email),
          address = COALESCE($6, address),
          latitude = COALESCE($7, latitude),
          longitude = COALESCE($8, longitude),
          opening_hours = COALESCE($9, opening_hours),
          delivery_available = COALESCE($10, delivery_available),
          pickup_available = COALESCE($11, pickup_available),
          is_open = COALESCE($12, is_open),
          banner_url = COALESCE($13, banner_url),
          updated_at = NOW()
         WHERE owner_id = $14
         RETURNING *`,
        [
          name?.trim() || null,
          category?.trim() || null,
          description?.trim() || null,
          phone?.trim() || null,
          email?.trim() || null,
          address?.trim() || null,
          latitude != null && latitude !== '' ? Number(latitude) : null,
          longitude != null && longitude !== '' ? Number(longitude) : null,
          parsedHours ? JSON.stringify(parsedHours) : null,
          deliveryAvailable !== undefined ? deliveryAvailable === true || deliveryAvailable === 'true' : null,
          pickupAvailable !== undefined ? pickupAvailable === true || pickupAvailable === 'true' : null,
          isOpen !== undefined ? isOpen === true || isOpen === 'true' : null,
          bannerUrl,
          req.user.id,
        ]
      );

      return res.json({ business: rows[0], message: 'Storefront updated successfully.' });
    } catch (error) {
      console.error('[Update Storefront] Error:', error);
      return res.status(500).json({ message: 'Failed to update storefront.' });
    }
  }
);

/**
 * GET /api/businesses/my/analytics (Vendor Insights Dashboard)
 */
router.get('/my/analytics', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const bizRes = await db.query('SELECT id FROM businesses WHERE owner_id = $1', [req.user.id]);
    if (bizRes.rows.length === 0) return res.status(404).json({ message: 'Business not found.' });
    const businessId = bizRes.rows[0].id;

    const [summaryRes, peakHoursRes, topProductsRes, lowStockRes] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)::int AS total_orders,
           COUNT(*) FILTER (WHERE status IN ('pending', 'accepted', 'preparing', 'ready_for_pickup', 'en_route'))::int AS active_orders,
           COALESCE(SUM(subtotal) FILTER (WHERE payment_status IN ('escrow_held', 'released')), 0)::numeric AS total_revenue
         FROM orders WHERE business_id = $1`,
        [businessId]
      ),
      db.query(
        `SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS order_count
         FROM orders WHERE business_id = $1
         GROUP BY hour ORDER BY hour ASC`,
        [businessId]
      ),
      db.query(
        `SELECT oi.item_name, SUM(oi.quantity)::int AS total_sold, SUM(oi.line_total)::numeric AS revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.business_id = $1
         GROUP BY oi.item_name
         ORDER BY total_sold DESC
         LIMIT 5`,
        [businessId]
      ),
      db.query(
        `SELECT id, name, stock_quantity, low_stock_threshold
         FROM products_services
         WHERE business_id = $1 AND item_type = 'product' AND stock_quantity <= low_stock_threshold`,
        [businessId]
      ),
    ]);

    return res.json({
      summary: summaryRes.rows[0],
      peakHours: peakHoursRes.rows,
      topProducts: topProductsRes.rows,
      lowStockItems: lowStockRes.rows,
    });
  } catch (error) {
    console.error('[Vendor Analytics] Error:', error);
    return res.status(500).json({ message: 'Failed to load vendor analytics.' });
  }
});

/**
 * GET /api/businesses/:id
 * Single business storefront + products & services
 */
router.get('/:id', optionalAuthenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const bizRes = await db.query(
      "SELECT * FROM businesses WHERE id = $1 AND approval_status = 'approved'",
      [id]
    );
    if (bizRes.rows.length === 0) {
      return res.status(404).json({ message: 'Business not found or not yet approved.' });
    }

    const itemsRes = await db.query(
      `SELECT * FROM products_services
       WHERE business_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    return res.json({
      business: bizRes.rows[0],
      items: itemsRes.rows,
    });
  } catch (error) {
    console.error('[Business Storefront] Error:', error);
    return res.status(500).json({ message: 'Failed to load business storefront.' });
  }
});

module.exports = router;

