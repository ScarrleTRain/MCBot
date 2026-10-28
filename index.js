const mineflayer = require('mineflayer');
const express = require('express');

// Configure these as environment variables on Render
const HOST = process.env.MC_HOST;                        // e.g. yourserver.aternos.me
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const USERNAME = process.env.MC_USERNAME || 'CreeperFarm';
const VERSION = process.env.MC_VERSION || false;         // e.g. "1.20.4"; false = auto-detect
const RETRY_MS = parseInt(process.env.RETRY_MS || '60000', 10);

// Optional: AFK pool coordinates. Needs the bot to be opped on the server.
// Set AFK_X, AFK_Y, AFK_Z on Render (e.g. 120 64 -340). Leave unset to skip teleporting.
const AFK_POS = ['AFK_X', 'AFK_Y', 'AFK_Z'].every((k) => process.env[k] !== undefined)
  ? [process.env.AFK_X, process.env.AFK_Y, process.env.AFK_Z]
  : null;

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

  // Fires on first join and again after every death/respawn
  bot.on('spawn', () => {
    status = 'online';
    console.log('Bot spawned');

    // Go to the AFK pool (requires op). Delay so the server finishes the login.
    if (AFK_POS) {
      setTimeout(() => {
        if (bot) bot.chat(`/tp ${USERNAME} ${AFK_POS.join(' ')}`);
      }, 3000);
    }

    // Anti-idle without moving: turn the head and swing the arm
    if (!moveTimer) {
      moveTimer = setInterval(() => {
        if (!bot || !bot.entity) return;
        bot.look(Math.random() * Math.PI * 2, 0, true);
        bot.swingArm('right');
      }, 20000);
    }
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
