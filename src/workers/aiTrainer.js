/**
 * Non-blocking Worker Thread for off-peak TensorFlow.js training:
 *  1. Product co-occurrence & popularity matrix + TF.js scoring weights
 *  2. Delivery ETA regression model (distance_km, hour_of_day, day_of_week -> minutes)
 */
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');
const db = require('../config/db');
const env = require('../config/env');

async function trainModels() {
  if (!fs.existsSync(env.ai.modelDir)) {
    fs.mkdirSync(env.ai.modelDir, { recursive: true });
  }

  // 1. Train ETA Regression Model from trip_analytics
  const { rows: trips } = await db.query(
    `SELECT distance_km, hour_of_day, day_of_week, actual_duration_minutes
     FROM trip_analytics
     ORDER BY created_at DESC
     LIMIT 2000`
  );

  let etaModelInfo = { trainedOn: trips.length, weights: null, bias: null };

  if (trips.length >= 5) {
    const xsData = trips.map((t) => [
      Number(t.distance_km) / 20, // normalize ~0..1
      Number(t.hour_of_day) / 23,
      Number(t.day_of_week) / 6,
    ]);
    const ysData = trips.map((t) => [Number(t.actual_duration_minutes)]);

    const xs = tf.tensor2d(xsData);
    const ys = tf.tensor2d(ysData);

    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 8, activation: 'relu', inputShape: [3] }));
    model.add(tf.layers.dense({ units: 1 }));
    model.compile({ optimizer: tf.train.adam(0.05), loss: 'meanSquaredError' });

    await model.fit(xs, ys, { epochs: 40, verbose: 0 });

    const weights = model.getWeights().map((w) => ({
      shape: w.shape,
      data: Array.from(w.dataSync()),
    }));

    etaModelInfo = {
      trainedAt: new Date().toISOString(),
      trainedOn: trips.length,
      weights,
    };

    xs.dispose();
    ys.dispose();
    model.dispose();
  }

  fs.writeFileSync(
    path.join(env.ai.modelDir, 'eta_model.json'),
    JSON.stringify(etaModelInfo, null, 2)
  );

  // 2. Build Recommendation Co-occurrence & Popularity Index
  const { rows: behaviors } = await db.query(
    `SELECT user_id, product_id, weight
     FROM user_behaviors
     WHERE created_at >= NOW() - INTERVAL '90 days'
     LIMIT 10000`
  );

  const productScores = {};
  const userItems = {};

  for (const b of behaviors) {
    const pid = b.product_id;
    const w = Number(b.weight) || 1;
    productScores[pid] = (productScores[pid] || 0) + w;
    if (b.user_id) {
      if (!userItems[b.user_id]) userItems[b.user_id] = new Set();
      userItems[b.user_id].add(pid);
    }
  }

  const coOccurrence = {};
  for (const itemsSet of Object.values(userItems)) {
    const items = Array.from(itemsSet);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (!coOccurrence[a]) coOccurrence[a] = {};
        if (!coOccurrence[b]) coOccurrence[b] = {};
        coOccurrence[a][b] = (coOccurrence[a][b] || 0) + 1;
        coOccurrence[b][a] = (coOccurrence[b][a] || 0) + 1;
      }
    }
  }

  fs.writeFileSync(
    path.join(env.ai.modelDir, 'rec_index.json'),
    JSON.stringify(
      {
        trainedAt: new Date().toISOString(),
        interactionCount: behaviors.length,
        productScores,
        coOccurrence,
      },
      null,
      2
    )
  );

  return { tripsTrained: trips.length, behaviorsIndexed: behaviors.length };
}

trainModels()
  .then((summary) => {
    if (parentPort) parentPort.postMessage({ ok: true, summary });
    process.exit(0);
  })
  .catch((err) => {
    if (parentPort) parentPort.postMessage({ ok: false, error: err.message });
    process.exit(1);
  });

