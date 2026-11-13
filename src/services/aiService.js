const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const tf = require('@tensorflow/tfjs');
const db = require('../config/db');
const env = require('../config/env');

let isTraining = false;

/**
 * Spawns the off-peak TensorFlow.js training worker thread.
 */
function triggerOffPeakTraining() {
  if (isTraining) return Promise.resolve({ skipped: true, reason: 'Training already in progress' });
  isTraining = true;

  return new Promise((resolve) => {
    const workerPath = path.resolve(__dirname, '../workers/aiTrainer.js');
    const worker = new Worker(workerPath);

    worker.on('message', (msg) => {
      isTraining = false;
      resolve(msg);
    });
    worker.on('error', (err) => {
      isTraining = false;
      console.error('[AIService] Worker error:', err.message);
      resolve({ ok: false, error: err.message });
    });
    worker.on('exit', () => {
      isTraining = false;
    });
  });
}

function loadJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // ignore corrupt cache
  }
  return null;
}

/**
 * Predicts delivery ETA in minutes using the local TF.js regression weights,
 * with a clean physical baseline fallback when historical data is sparse.
 */
function predictEtaMinutes(distanceKm = 2, date = new Date()) {
  const dist = Math.max(0.2, Number(distanceKm) || 2);
  const hour = date.getHours();
  const day = date.getDay();

  // Baseline: 8 min prep/handoff + 3.2 min per km + rush-hour factor
  const isRushHour = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 20);
  const baseline = Math.round(8 + dist * 3.2 + (isRushHour ? 6 : 0));

  const etaModelData = loadJsonSafe(path.join(env.ai.modelDir, 'eta_model.json'));
  if (!etaModelData || !etaModelData.weights || etaModelData.trainedOn < 5) {
    return {
      estimatedMinutes: baseline,
      source: 'baseline_matrix',
      trainedSamples: etaModelData?.trainedOn || 0,
    };
  }

  try {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 8, activation: 'relu', inputShape: [3] }));
    model.add(tf.layers.dense({ units: 1 }));
    const weightTensors = etaModelData.weights.map((w) => tf.tensor(w.data, w.shape));
    model.setWeights(weightTensors);

    const input = tf.tensor2d([[dist / 20, hour / 23, day / 6]]);
    const output = model.predict(input);
    const predicted = Math.round(Number(output.dataSync()[0]));

    input.dispose();
    output.dispose();
    weightTensors.forEach((t) => t.dispose());
    model.dispose();

    const clamped = Math.max(8, Math.min(120, Number.isFinite(predicted) ? predicted : baseline));
    return {
      estimatedMinutes: clamped,
      source: 'tensorflow_regression',
      trainedSamples: etaModelData.trainedOn,
    };
  } catch {
    return {
      estimatedMinutes: baseline,
      source: 'baseline_fallback',
      trainedSamples: 0,
    };
  }
}

/**
 * Generates personalized "Recommended For You" products using TF.js similarity/scores
 * and real database availability.
 */
async function getPersonalizedRecommendations(userId, limit = 8) {
  const recIndex = loadJsonSafe(path.join(env.ai.modelDir, 'rec_index.json'));

  // Get user's recent interacted products
  let userHistoryIds = [];
  if (userId) {
    const { rows } = await db.query(
      `SELECT product_id, SUM(weight) AS score
       FROM user_behaviors
       WHERE user_id = $1
       GROUP BY product_id
       ORDER BY score DESC
       LIMIT 10`,
      [userId]
    );
    userHistoryIds = rows.map((r) => r.product_id);
  }

  // Score candidate products from approved businesses
  const { rows: products } = await db.query(
    `SELECT p.*, b.name AS business_name, b.category AS business_category
     FROM products_services p
     JOIN businesses b ON b.id = p.business_id
     WHERE b.approval_status = 'approved'
       AND p.is_available = TRUE
       AND (p.item_type = 'service' OR p.stock_quantity > 0)
     ORDER BY p.created_at DESC
     LIMIT 100`
  );

  if (products.length === 0) return [];

  const coOcc = recIndex?.coOccurrence || {};
  const popScores = recIndex?.productScores || {};

  const scored = products.map((p) => {
    let score = Number(popScores[p.id] || 0) * 0.5;
    for (const histId of userHistoryIds) {
      if (histId === p.id) score += 2;
      if (coOcc[histId] && coOcc[histId][p.id]) {
        score += Number(coOcc[histId][p.id]) * 4;
      }
    }
    return { ...p, _aiScore: score };
  });

  scored.sort((a, b) => b._aiScore - a._aiScore);
  return scored.slice(0, limit).map(({ _aiScore, ...rest }) => rest);
}

/**
 * Generates "Frequently Bought Together" for a specific product.
 */
async function getFrequentlyBoughtTogether(productId, limit = 4) {
  const recIndex = loadJsonSafe(path.join(env.ai.modelDir, 'rec_index.json'));
  const relatedMap = recIndex?.coOccurrence?.[productId] || {};
  const relatedIds = Object.entries(relatedMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (relatedIds.length > 0) {
    const { rows } = await db.query(
      `SELECT p.*, b.name AS business_name
       FROM products_services p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.id = ANY($1::uuid[]) AND b.approval_status = 'approved' AND p.is_available = TRUE`,
      [relatedIds]
    );
    if (rows.length > 0) return rows;
  }

  // Fallback: other available items from the same business or category
  const { rows } = await db.query(
    `SELECT p.*, b.name AS business_name
     FROM products_services p
     JOIN businesses b ON b.id = p.business_id
     WHERE p.id <> $1
       AND b.approval_status = 'approved'
       AND p.is_available = TRUE
       AND p.business_id = (SELECT business_id FROM products_services WHERE id = $1)
     LIMIT $2`,
    [productId, limit]
  );
  return rows;
}

module.exports = {
  triggerOffPeakTraining,
  predictEtaMinutes,
  getPersonalizedRecommendations,
  getFrequentlyBoughtTogether,
};
