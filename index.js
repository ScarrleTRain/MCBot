const mineflayer = require('mineflayer');
const express = require('express');
const util = require('util');

// ---- Config (set as environment variables on Render) ----
const HOST = process.env.MC_HOST;                         // e.g. yourserver.aternos.me
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const VERSION = process.env.MC_VERSION || false;          // e.g. "26.1.2"; false = auto-detect
const RETRY_MS = parseInt(process.env.RETRY_MS || '60000', 10);
const STAGGER_MS = parseInt(process.env.STAGGER_MS || '5000', 10); // delay between bot logins

// One or more bot names, comma-separated: MC_USERNAMES=CreeperFarm,CreeperFarm2
const USERNAMES = (process.env.MC_USERNAMES || process.env.MC_USERNAME || 'CreeperFarm')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!HOST) {
  console.error('MC_HOST is required');
  process.exit(1);
}

console.log('Mineflayer version:', require('mineflayer/package.json').version);
console.log('Bots:', USERNAMES.join(', '));

const statuses = {};

function startBot(username) {
  let bot = null;
  let moveTimer = null;
  let retryTimer = null;
  const log = (...a) => console.log(`[${username}]`, ...a);
  statuses[username] = 'starting';

  function scheduleReconnect() {
    if (retryTimer) return;
    statuses[username] = `offline, retrying in ${RETRY_MS / 1000}s`;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RETRY_MS);
  }

  function connect() {
    statuses[username] = 'connecting';
    log(`Connecting to ${HOST}:${PORT} (version: ${VERSION || 'auto'})`);

    let ended = false;
    const b = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username,
      version: VERSION,
      auth: 'offline', // requires "Cracked" enabled on the Aternos server
    });
    bot = b;

    const cleanup = (reason) => {
      if (ended) return;
      ended = true;
      clearTimeout(watchdog);
      log('Disconnected:', reason);
      if (moveTimer) clearInterval(moveTimer);
      moveTimer = null;
      bot = null;
      scheduleReconnect();
    };

    // Give up and retry if nothing happens within 30s
    const watchdog = setTimeout(() => {
      if (statuses[username] === 'connecting') {
        log('No response after 30s. Is the server Online? Check MC_PORT and MC_VERSION.');
        try { b.end(); } catch (_) {}
        cleanup('connect timeout');
      }
    }, 30000);

    b._client.on('connect', () => log('TCP connection opened'));
    b.on('login', () => log('Logged in, waiting for spawn'));
    b.on('messagestr', (m) => log('Chat:', m));

    // Fires on first join and again after every death/respawn
    b.on('spawn', () => {
      clearTimeout(watchdog);
      statuses[username] = 'online';
      log('Spawned');

      // Anti-idle without moving: just turn the head every so often
      if (!moveTimer) {
        moveTimer = setInterval(() => {
          if (!bot || !bot.entity) return;
          bot.look(Math.random() * Math.PI * 2, 0, true);
        }, 5000);
      }
    });

    b.on('end', cleanup);
    b.on('kicked', (r) => log('Kicked:', util.inspect(r, { depth: null })));
    b.on('error', (e) => log('Error:', e.message));
  }

  connect();
}

// Start bots one after another so the server doesn't throttle the logins
USERNAMES.forEach((name, i) => setTimeout(() => startBot(name), i * STAGGER_MS));

// Health endpoint for UptimeRobot (keeps the Render free service awake)
const app = express();
app.get('/', (_req, res) =>
  res.send(Object.entries(statuses).map(([n, s]) => `${n}: ${s}`).join('\n') || 'starting'));
app.listen(process.env.PORT || 3000, () => console.log('Web server up'));
