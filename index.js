const mineflayer = require('mineflayer');
const express = require('express');

// Configure these as environment variables on Render
const HOST = process.env.MC_HOST;                        // e.g. yourserver.aternos.me
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const USERNAME = process.env.MC_USERNAME || 'AFK_Bot';
const VERSION = process.env.MC_VERSION || false;         // e.g. "1.20.4"; false = auto-detect
const RETRY_MS = parseInt(process.env.RETRY_MS || '60000', 10);

if (!HOST) {
  console.error('MC_HOST is required');
  process.exit(1);
}

let status = 'starting';
let bot = null;
let moveTimer = null;
let retryTimer = null;

function scheduleReconnect() {
  if (retryTimer) return;
  status = `offline, retrying in ${RETRY_MS / 1000}s`;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, RETRY_MS);
}

function connect() {
  status = 'connecting';
  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: 'offline', // requires "Cracked" enabled on the Aternos server
  });

  bot.once('spawn', () => {
    status = 'online';
    console.log('Bot spawned');
    // Small random movement so the bot isn't kicked as idle
    moveTimer = setInterval(() => {
      if (!bot || !bot.entity) return;
      bot.setControlState('jump', true);
      setTimeout(() => bot && bot.setControlState('jump', false), 300);
      bot.look(Math.random() * Math.PI * 2, 0, true);
    }, 20000);
  });

  const cleanup = (reason) => {
    console.log('Disconnected:', reason);
    if (moveTimer) clearInterval(moveTimer);
    moveTimer = null;
    bot = null;
    scheduleReconnect();
  };

  bot.on('end', cleanup);
  bot.on('kicked', (r) => console.log('Kicked:', r));
  bot.on('error', (e) => console.log('Error:', e.message));
}

// Health endpoint for UptimeRobot (keeps the Render free service awake)
const app = express();
app.get('/', (_req, res) => res.send(`AFK bot status: ${status}`));
app.listen(process.env.PORT || 3000, () => console.log('Web server up'));

connect();
