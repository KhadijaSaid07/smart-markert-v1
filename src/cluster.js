/**
 * Stateless API Clustering Entry Point
 * Distributes load across all available CPU cores.
 */
const cluster = require('cluster');
const os = require('os');
const { startServer } = require('./server');

if (cluster.isPrimary) {
  const numCPUs = Math.min(os.cpus().length, 4);
  console.log(`[Cluster] Primary ${process.pid} spawning ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker) => {
    console.warn(`[Cluster] Worker ${worker.process.pid} exited. Respawning...`);
    cluster.fork();
  });
} else {
  startServer();
}

