#!/usr/bin/env node
/**
 * Scout Tester — Express Entry Point
 *
 * Thin boot script. Loads env, initialises persistence, creates the
 * express app, mounts static assets and API routes, wires SSE, and
 * handles graceful shutdown. All logic lives in `src/` and `server/`.
 */

import express from 'express';
import { join } from 'path';
import { loadEnv, PORT, ROOT_DIR, initCountries } from './src/config/index.js';
import { initResults, loadSites, getResults, saveResultsNow } from './src/results/index.js';
import { migrateOldRuns, loadRunsIndex } from './src/runs/index.js';
import { broadcast, streamHandler, startHeartbeat, closeSseClients } from './server/sse.js';
import { mountApiRoutes } from './server/routes/index.js';
import { logger } from './src/logger/index.js';

// ─── Bootstrap ───

async function start() {
  loadEnv();
  await initCountries();
  initResults();
  migrateOldRuns();

  // ─── Express App ───

  const app = express();
  app.use(express.json());

  // ─── SSE ───

  app.get('/api/events', streamHandler);
  const heartbeatInterval = startHeartbeat(5000);

  // ─── Static ───

  app.use('/web', express.static(join(ROOT_DIR, 'web')));
  app.get('/', (req, res) => res.sendFile(join(ROOT_DIR, 'index.html')));
  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  // ─── API ───

  mountApiRoutes(app, broadcast);

  // ─── Start ───

  const server = app.listen(PORT, () => {
    const sites = loadSites();
    const results = getResults();
    const prev = Object.keys(results).length;
    const passes = Object.values(results).filter((r) => r.verdict === 'PASS').length;
    const index = loadRunsIndex();
    logger.info(`Scout Block Check`);
    logger.info(`http://localhost:${PORT}`);
    logger.info(`${sites.length} sites | ${prev} tested | ${passes} passing`);
    logger.info(`${index.runs.length} previous test runs`);
  });

  // ─── Graceful Shutdown ───

  function shutdown(signal) {
    logger.info(`${signal} received — shutting down...`);
    saveResultsNow();
    clearInterval(heartbeatInterval);
    closeSseClients();
    server.close(() => {
      logger.info('Server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});
