-- JamiiMarket (Smart Marketplace for Local Businesses) PostgreSQL Schema
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Users (Customers, Vendors, Delivery Riders, System Administrators)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(180) UNIQUE NOT NULL,
  phone VARCHAR(40),
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('customer', 'vendor', 'rider', 'admin')),
  -- Vendors and Riders must be 'approved' by Admin before accessing services
  approval_status VARCHAR(20) NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected', 'suspended')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  location_label VARCHAR(200),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  vehicle_type VARCHAR(60),
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  preferred_language VARCHAR(5) NOT NULL DEFAULT 'en',
  avatar_url TEXT,
  reset_token_hash TEXT,
  reset_token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role_approval ON users(role, approval_status);
CREATE INDEX IF NOT EXISTS idx_users_geo ON users(latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- 2. Businesses (Vendor Storefronts)
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT,
  phone VARCHAR(40),
  email VARCHAR(180),
  address VARCHAR(255),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  opening_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  banner_url TEXT,
  logo_url TEXT,
  delivery_available BOOLEAN NOT NULL DEFAULT TRUE,
  pickup_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_owner ON businesses(owner_id);
CREATE INDEX IF NOT EXISTS idx_businesses_geo ON businesses(latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_businesses_category_status ON businesses(category, approval_status);

-- 3. Products & Services (Catalog, Inventory, Dynamic Pricing, Combos, Hourly Billing)
CREATE TABLE IF NOT EXISTS products_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  item_type VARCHAR(20) NOT NULL DEFAULT 'product' CHECK (item_type IN ('product', 'service')),
  name VARCHAR(160) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  promo_price NUMERIC(12, 2) CHECK (promo_price >= 0),
  promo_ends_at TIMESTAMPTZ,
  billing_type VARCHAR(20) NOT NULL DEFAULT 'unit' CHECK (billing_type IN ('unit', 'hourly', 'service')),
  unit_label VARCHAR(40) DEFAULT 'item',
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  combo_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_business ON products_services(business_id);
CREATE INDEX IF NOT EXISTS idx_products_type_avail ON products_services(item_type, is_available);

-- 4. Favorites (Customers saving businesses or products)
CREATE TABLE IF NOT EXISTS favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products_services(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, business_id),
  UNIQUE (user_id, product_id)
);

-- 5. Smart Cart Items (Multi-vendor persistent cart)
CREATE TABLE IF NOT EXISTS cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products_services(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  selected_combo JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);

-- 6. Parent Checkout Sessions & Split Vendor Orders
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(40) UNIQUE NOT NULL,
  checkout_group_id UUID NOT NULL,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  fulfillment_type VARCHAR(20) NOT NULL DEFAULT 'delivery' CHECK (fulfillment_type IN ('delivery', 'pickup')),
  delivery_address VARCHAR(255),
  delivery_latitude DOUBLE PRECISION,
  delivery_longitude DOUBLE PRECISION,
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'preparing', 'ready_for_pickup', 'en_route', 'delivered', 'completed', 'cancelled')),
  payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending_stk', 'escrow_held', 'released', 'refunded', 'failed')),
  pod_pin_hash TEXT,
  pod_pin_plain VARCHAR(4),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_business ON orders(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products_services(id) ON DELETE SET NULL,
  item_name VARCHAR(160) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL,
  line_total NUMERIC(12, 2) NOT NULL,
  selected_combo JSONB
);

-- 7. Service Bookings (Calendar scheduling for service providers)
CREATE TABLE IF NOT EXISTS service_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_number VARCHAR(40) UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES products_services(id) ON DELETE CASCADE,
  booking_date DATE NOT NULL,
  time_slot VARCHAR(30) NOT NULL,
  duration_hours NUMERIC(4, 1) NOT NULL DEFAULT 1.0,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status VARCHAR(25) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_business_date ON service_bookings(business_id, booking_date);

-- 8. Deliveries & Geo-Fenced Rider Logistics
CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  rider_id UUID REFERENCES users(id) ON DELETE SET NULL,
  pickup_address VARCHAR(255),
  pickup_latitude DOUBLE PRECISION,
  pickup_longitude DOUBLE PRECISION,
  dropoff_address VARCHAR(255),
  dropoff_latitude DOUBLE PRECISION,
  dropoff_longitude DOUBLE PRECISION,
  distance_km NUMERIC(8, 2) DEFAULT 0,
  rider_fee NUMERIC(12, 2) DEFAULT 0,
  estimated_minutes INTEGER DEFAULT 25,
  status VARCHAR(30) NOT NULL DEFAULT 'awaiting_rider' CHECK (status IN ('awaiting_rider', 'assigned', 'picked_up', 'en_route', 'delivered', 'cancelled')),
  assigned_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_rider ON deliveries(rider_id);

-- 9. Payments & Internal Escrow Ledger
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_group_id UUID,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL CHECK (provider IN ('mpesa', 'airtel', 'tigo', 'paystack', 'sandbox')),
  phone_number VARCHAR(40) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  checkout_request_id VARCHAR(120),
  mpesa_receipt VARCHAR(120),
  status VARCHAR(30) NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'escrow_held', 'released', 'failed', 'refunded')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escrow_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  available_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  held_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_earned NUMERIC(14, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escrow_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  wallet_id UUID NOT NULL REFERENCES escrow_wallets(id) ON DELETE CASCADE,
  tx_type VARCHAR(30) NOT NULL CHECK (tx_type IN ('escrow_hold', 'escrow_release', 'rider_payout', 'refund')),
  amount NUMERIC(12, 2) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. AI Behavior Tracking & Historical Trip Matrix
CREATE TABLE IF NOT EXISTS user_behaviors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  product_id UUID NOT NULL REFERENCES products_services(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  action_type VARCHAR(20) NOT NULL CHECK (action_type IN ('view', 'click', 'cart_add', 'purchase')),
  weight NUMERIC(4, 2) NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_behaviors_user ON user_behaviors(user_id);
CREATE INDEX IF NOT EXISTS idx_behaviors_product ON user_behaviors(product_id);

CREATE TABLE IF NOT EXISTS trip_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  distance_km NUMERIC(8, 2) NOT NULL,
  hour_of_day INTEGER NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  actual_duration_minutes NUMERIC(8, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Real-Time Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  message TEXT NOT NULL,
  category VARCHAR(40) NOT NULL DEFAULT 'system',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);

-- 12. User Feedback & Reports
CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_role VARCHAR(20),
  category VARCHAR(50) NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'bug', 'feature', 'complaint', 'praise')),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  subject VARCHAR(160) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved')),
  admin_response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. Admin Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email VARCHAR(180),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(60),
  target_id VARCHAR(100),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
