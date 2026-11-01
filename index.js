const mineflayer = require('mineflayer');
const express = require('express');
const path = require('path');
const util = require('util');

// ---- Config (set as environment variables on Render) ----
const HOST = process.env.MC_HOST;                         // e.g. yourserver.aternos.me
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const VERSION = process.env.MC_VERSION || false;          // e.g. "26.1.2"; false = auto-detect
const RETRY_MS = parseInt(process.env.RETRY_MS || '60000', 10);
const STAGGER_MS = parseInt(process.env.STAGGER_MS || '5000', 10); // delay between bot logins
const SHOW_COORDS = process.env.SHOW_COORDS === 'true';   // the page is public, so off by default

// One or more bot names, comma-separated: MC_USERNAMES=CreeperFarm,CreeperFarm2
const USERNAMES = (process.env.MC_USERNAMES || process.env.MC_USERNAME || 'CreeperFarm')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!HOST) {
  console.error('MC_HOST is required');
  process.exit(1);
}

console.log('Mineflayer version:', require('mineflayer/package.json').version);
console.log('Bots:', USERNAMES.join(', '));

// ---- Shared state for the dashboard ----
const states = {};
const events = []; // newest last, shared by all bots

function addEvent(text) {
  const now = Date.now();
  const last = events[events.length - 1];
  // Both bots see the same chat, so skip an identical line seen in the last 3 seconds
  if (last && last.text === text && now - last.t < 3000) return;
  events.push({ t: now, text: String(text).slice(0, 200) });
  if (events.length > 30) events.shift();
}

function countHostiles(b) {
  try {
    const me = b.entity.position;
    return Object.values(b.entities).filter(
      (e) => e !== b.entity && e.type === 'hostile' && e.position.distanceTo(me) <= 32
    ).length;
  } catch (_) {
    return null;
  }
}

function snapshot(name) {
  const s = states[name];
  const b = s.bot;
  const out = {
    name,
    status: s.status,
    deaths: s.deaths,
    reconnects: s.reconnects,
    onlineSince: s.since,
  };
  if (b && s.status === 'online' && b.entity) {
    out.health = b.health;
    out.food = b.food;
    out.dimension = b.game && b.game.dimension;
    out.gameMode = b.game && b.game.gameMode;
    out.ping = b.player && b.player.ping;
    out.timeOfDay = b.time && b.time.timeOfDay;
    out.raining = b.isRaining;
    out.players = Object.keys(b.players || {}).filter((n) => !USERNAMES.includes(n));
    out.hostilesNearby = countHostiles(b);
    if (SHOW_COORDS) {
      const p = b.entity.position;
      out.position = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    }
  }
  return out;
}

// ---- Diagnostics: work out which server the bots are really on ----
function pingServer(log) {
  try {
    const mc = require('minecraft-protocol');
    mc.ping({ host: HOST, port: PORT }, (err, r) => {
      if (err) return log('Server ping failed:', err.message);
      const motd = typeof r.description === 'string' ? r.description : JSON.stringify(r.description);
      log('Server ping:', JSON.stringify({
        motd,
        version: r.version,
        players: r.players && { online: r.players.online, max: r.players.max, sample: r.players.sample },
      }));
    });
  } catch (e) {
    log('Ping unavailable:', e.message);
  }
}

function describeServer(b, log) {
  try {
    const p = b.entity && b.entity.position;
    log('Server details:', JSON.stringify({
      spawnedAt: p && { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      worldSpawn: b.spawnPoint && { x: b.spawnPoint.x, y: b.spawnPoint.y, z: b.spawnPoint.z },
      gameMode: b.game && b.game.gameMode,
      difficulty: b.game && b.game.difficulty,
      dimension: b.game && b.game.dimension,
      maxPlayers: b.game && b.game.maxPlayers,
      worldDay: b.time && b.time.day,
      playersInTabList: Object.keys(b.players || {}),
    }));
  } catch (e) {
    log('Could not read server details:', e.message);
  }
  pingServer(log);
}

// ---- Bots ----
function startBot(username) {
  const state = { status: 'starting', bot: null, since: null, deaths: 0, reconnects: 0 };
  states[username] = state;
  let moveTimer = null;
  let retryTimer = null;
  let everConnected = false;
  const log = (...a) => console.log(`[${username}]`, ...a);

  function scheduleReconnect() {
    if (retryTimer) return;
    state.status = `offline, retrying in ${RETRY_MS / 1000}s`;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RETRY_MS);
  }

  function connect() {
    state.status = 'connecting';
    log(`Connecting to ${HOST}:${PORT} (version: ${VERSION || 'auto'})`);

    let ended = false;
    const b = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username,
      version: VERSION,
      auth: 'offline', // requires "Cracked" enabled on the Aternos server
    });
    state.bot = b;

    const cleanup = (reason) => {
      if (ended) return;
      ended = true;
      clearTimeout(watchdog);
      log('Disconnected:', reason);
      if (everConnected) addEvent(`${username} disconnected`);
      if (moveTimer) clearInterval(moveTimer);
      moveTimer = null;
      state.bot = null;
      state.since = null;
      scheduleReconnect();
    };

    // Give up and retry if nothing happens within 30s
    const watchdog = setTimeout(() => {
      if (state.status === 'connecting') {
        log('No response after 30s. Is the server Online? Check MC_PORT and MC_VERSION.');
        try { b.end(); } catch (_) {}
        cleanup('connect timeout');
      }
    }, 30000);

    b._client.on('connect', () => log('TCP connection opened'));
    b.on('login', () => log('Logged in, waiting for spawn'));
    b.on('messagestr', (m) => {
      log('Chat:', m);
      if (m && m.trim()) addEvent(m);
    });

    // Fires on first join and again after every death/respawn
    b.on('spawn', () => {
      clearTimeout(watchdog);
      state.status = 'online';
      if (!state.since) {
        state.since = Date.now();
        if (everConnected) state.reconnects += 1;
        addEvent(`${username} joined the server`);
      }
      everConnected = true;
      log('Spawned');
      if (!b._diagnosed) {
        b._diagnosed = true;
        setTimeout(() => describeServer(b, log), 2000);
      }

      // Anti-idle without moving: just turn the head every so often
      if (!moveTimer) {
        moveTimer = setInterval(() => {
          if (!b.entity) return;
          b.look(Math.random() * Math.PI * 2, 0, true);
        }, 20000);
      }
    });

    b.on('death', () => {
      state.deaths += 1;
      addEvent(`${username} died`);
    });
    b.on('end', cleanup);
    b.on('kicked', (r) => {
      log('Kicked:', util.inspect(r, { depth: null }));
      addEvent(`${username} was kicked`);
    });
    b.on('error', (e) => log('Error:', e.message));
  }

  connect();
}

// Start bots one after another so the server doesn't throttle the logins
USERNAMES.forEach((name, i) => setTimeout(() => startBot(name), i * STAGGER_MS));

// ---- Web dashboard (also the health endpoint for UptimeRobot) ----
const app = express();
const fs = require('fs');
const PAGE_CANDIDATES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html'),
];
app.get('/', (_req, res) => {
  const page = PAGE_CANDIDATES.find((f) => fs.existsSync(f));
  if (page) return res.sendFile(page);
  res.status(500).type('text/plain').send(
    'Dashboard file not found.\n\nLooked for:\n' + PAGE_CANDIDATES.join('\n') +
    '\n\nFiles next to index.js: ' + fs.readdirSync(__dirname).join(', ') +
    '\n\nAdd public/index.html to your repo and redeploy. The bots are still running: see /api/status.'
  );
});
app.get('/health', (_req, res) => res.send('ok'));
app.get('/api/status', (_req, res) => {
  res.json({
    bots: USERNAMES.map((n) =>
      states[n] ? snapshot(n) : { name: n, status: 'starting', deaths: 0, reconnects: 0 }
    ),
    events: events.slice(-15).reverse(),
    now: Date.now(),
  });
});
app.listen(process.env.PORT || 3000, () => console.log('Web server up'));
