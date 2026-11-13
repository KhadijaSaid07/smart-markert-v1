const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const { authenticate, authorize } = require('../middleware/auth');
const { createAndEmitNotification } = require('../services/notificationService');

const router = express.Router();

/**
 * POST /api/payments/stk-push
 * Initiates Mobile Money STK Push (M-Pesa / Airtel Money / Tigo Pesa) and holds funds in Escrow.
 * Uses sandbox mode unless real Daraja credentials are configured in .env.
 */
router.post('/stk-push', authenticate, authorize('customer'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { orderId, checkoutGroupId, provider = 'mpesa', phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ message: 'Mobile money phone number is required.' });
    }
    if (!orderId && !checkoutGroupId) {
      return res.status(400).json({ message: 'orderId or checkoutGroupId is required.' });
    }

    const { rows: orders } = orderId
      ? await client.query(
          `SELECT o.*, b.owner_id AS vendor_user_id
           FROM orders o JOIN businesses b ON b.id = o.business_id
           WHERE o.id = $1 AND o.customer_id = $2`,
          [orderId, req.user.id]
        )
      : await client.query(
          `SELECT o.*, b.owner_id AS vendor_user_id
           FROM orders o JOIN businesses b ON b.id = o.business_id
           WHERE o.checkout_group_id = $1 AND o.customer_id = $2`,
          [checkoutGroupId, req.user.id]
        );

    if (orders.length === 0) {
      return res.status(404).json({ message: 'Order(s) not found.' });
    }

    const totalAmount = orders.reduce((sum, o) => sum + Number(o.total_amount), 0);
    const checkoutRequestId = `JM-STK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const isSandbox = env.payments.mode !== 'live' || !env.payments.mpesaConsumerKey;

    await client.query('BEGIN');

    const createdPayments = [];
    for (const order of orders) {
      const status = isSandbox ? 'escrow_held' : 'initiated';
      const receipt = isSandbox ? `SIM-${crypto.randomBytes(4).toString('hex').toUpperCase()}` : null;

      const payRes = await client.query(
        `INSERT INTO payments (
          checkout_group_id, order_id, customer_id, provider, phone_number,
          amount, checkout_request_id, mpesa_receipt, status, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          order.checkout_group_id,
          order.id,
          req.user.id,
          provider,
          phoneNumber.trim(),
          order.total_amount,
          checkoutRequestId,
          receipt,
          status,
          JSON.stringify({ mode: isSandbox ? 'sandbox' : 'live' }),
        ]
      );
      createdPayments.push(payRes.rows[0]);

      if (isSandbox) {
        await client.query(
          `UPDATE orders SET payment_status = 'escrow_held', updated_at = NOW() WHERE id = $1`,
          [order.id]
        );

        // Hold vendor subtotal in vendor's escrow wallet until 4-digit PoD PIN is verified
        await client.query(
          `INSERT INTO escrow_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [order.vendor_user_id]
        );
        const walletRes = await client.query(
          `UPDATE escrow_wallets SET held_balance = held_balance + $1, updated_at = NOW()
           WHERE user_id = $2 RETURNING id`,
          [order.subtotal, order.vendor_user_id]
        );
        await client.query(
          `INSERT INTO escrow_transactions (order_id, wallet_id, tx_type, amount, description)
           VALUES ($1, $2, 'escrow_hold', $3, $4)`,
          [order.id, walletRes.rows[0].id, order.subtotal, `Escrow held for order ${order.order_number}`]
        );
      } else {
        await client.query(
          `UPDATE orders SET payment_status = 'pending_stk', updated_at = NOW() WHERE id = $1`,
          [order.id]
        );
      }
    }

    await client.query('COMMIT');

    if (isSandbox) {
      await createAndEmitNotification({
        userId: req.user.id,
        title: 'Payment Secured in Escrow',
        message: `Sandbox ${provider.toUpperCase()} payment of ${totalAmount} TZS succeeded and is held in escrow until delivery PIN verification.`,
        category: 'payment',
      });
    }

    return res.status(201).json({
      mode: isSandbox ? 'sandbox' : 'live',
      message: isSandbox
        ? 'Sandbox STK Push completed. Funds are safely held in JamiiMarket Escrow.'
        : 'STK Push sent to your phone. Enter your PIN to complete payment.',
      checkoutRequestId,
      totalAmount,
      payments: createdPayments,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[STK Push] Error:', error);
    return res.status(500).json({ message: 'Payment initiation failed.' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/payments/wallet
 * Returns current user's escrow wallet & transaction ledger (Vendor / Rider / Customer).
 */
router.get('/wallet', authenticate, async (req, res) => {
  const walletRes = await db.query('SELECT * FROM escrow_wallets WHERE user_id = $1', [req.user.id]);
  const wallet = walletRes.rows[0] || { available_balance: 0, held_balance: 0, total_earned: 0 };

  let transactions = [];
  if (wallet.id) {
    const txRes = await db.query(
      'SELECT * FROM escrow_transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 50',
      [wallet.id]
    );
    transactions = txRes.rows;
  }

  return res.json({ wallet, transactions });
});

module.exports = router;
