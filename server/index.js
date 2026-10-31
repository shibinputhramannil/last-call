import os from 'node:os';

// Give a clear instruction instead of a stack trace when `npm install` was skipped.
try {
  await import('ws');
} catch {
  console.error('\nLast Call could not start: its dependencies are not installed.');
  console.error('Run "npm install" in this folder once, then "npm start".\n');
  process.exit(1);
}

const { loadConfig } = await import('./config.js');
const { createApp } = await import('./app.js');
const { createLogger } = await import('./logger.js');
const { createNarrator } = await import('./narrator.js');
const { createSigner } = await import('./signing.js');
const { createStore, resolveSecret } = await import('./store.js');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`\nLast Call could not start: ${err.message}`);
  console.error('Check your environment variables or .env file (see .env.example).\n');
  process.exit(1);
}

const log = createLogger(config.logLevel);
const narrator = createNarrator(config.narrator, { log });
let store;
let saveSecret;
try {
  store = createStore({ dataDir: config.dataDir, log });
  saveSecret = resolveSecret({ secret: config.saveSecret, dataDir: config.dataDir });
} catch (err) {
  console.error(`\nLast Call could not start: DATA_DIR "${config.dataDir}" is not usable (${err.message}).`);
  console.error('Point DATA_DIR at a writable folder, or remove it to keep rooms in memory only.\n');
  process.exit(1);
}
if (saveSecret.source === 'ephemeral') {
  log.warn('SAVE_SECRET is not set: saved progress and room tickets will not survive a restart (see README, Persistence)');
}
const app = createApp(config, { narrator, log, store, signer: createSigner(saveSecret.secret) });

/** Addresses other devices on the same network can use. */
function networkUrls(port) {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

app.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nLast Call could not start: port ${config.port} is already in use.`);
    console.error('Close the other program using it, or pick another port:');
    console.error('  Windows (PowerShell):  $env:PORT=3001; npm start');
    console.error('  macOS / Linux:         PORT=3001 npm start\n');
  } else {
    log.error('server failed to start', { err });
  }
  process.exit(1);
});

app.server.listen(config.port, config.host, () => {
  const { port } = app.server.address();
  log.info('Last Call is running', {
    port,
    node: process.version,
    narrator: narrator.enabled ? config.narrator.model : 'built-in lines',
    rooms: store.persistent ? `saved in ${config.dataDir}` : 'memory',
  });
  if (process.stdout.isTTY) {
    console.log(`\n  Play here:            http://localhost:${port}`);
    if (config.host === '0.0.0.0' || config.host === '::') {
      for (const url of networkUrls(port)) console.log(`  Other devices nearby: ${url}`);
    }
    console.log('  Stop the server:      Ctrl+C\n');
  }
});

// ---- Graceful shutdown -------------------------------------------------------------
// Hosts send SIGTERM before replacing or stopping the server; Ctrl+C sends SIGINT.

const FORCE_EXIT_MS = 10_000;
let stopping = false;

async function stop(reason, exitCode = 0) {
  if (stopping) {
    if (reason === 'SIGINT') process.exit(exitCode || 130); // second Ctrl+C: quit now
    return;
  }
  stopping = true;
  const { rooms, players } = app.rooms.stats();
  log.info('shutting down', { reason, rooms, players });
  setTimeout(() => {
    log.error('shutdown took too long, exiting');
    process.exit(1);
  }, FORCE_EXIT_MS).unref();
  try {
    await app.shutdown();
    log.info('stopped cleanly');
  } catch (err) {
    log.error('error during shutdown', { err });
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err });
  stop('uncaughtException', 1);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled promise rejection', { err });
  stop('unhandledRejection', 1);
});
