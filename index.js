// ===== CONFIG =====
const CONFIG = {
  host: '127.0.0.1',
  port: 25565,
  version: '1.20.4',     // must match your server console
  auth: 'offline',
  apiPort: 3000,
  llm: {
    // Set in PowerShell:  $env:GEMINI_API_KEY="YOUR_KEY"
    apiKey: process.env.GEMINI_API_KEY || '',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    maxTokens: 200,
  },
  defaultGoal: 'explore the world', // <— your default LLM goal
  autoMode: {
    enabled: true,        // Auto-execute LLM decisions
    intervalMs: 3000,     // Time between actions (3 seconds)
    maxActions: 1000      // Safety limit
  },
  logging: {
    toFile: true,         // Enable file logging
    logFile: 'bot-actions.log',
    console: true,        // Also log to console
    maxFileSizeMB: 50     // Rotate log when it gets too big
  }
};

// ===== LOGGING CONTROLS =====
const LOG = {
  stateSummary: false,   // one-line state pings; false keeps console clean
  promptPreview: true,   // show short prompt preview
  llmText: true,         // log first line of LLM text only
  actionExec: true       // log chosen action and completion
};

// Quiet down noisy protocol errors like explosion packet partials
const QUIET_PROTOCOL_NOISE = true;
if (QUIET_PROTOCOL_NOISE) {
  const origError = console.error;
  console.error = (...args) => {
    const s = args.map(a => (typeof a === 'string' ? a : '')).join(' ');
    if (/^Chunk size is \d+ but only \d+ was read/i.test(s)) return;
    origError(...args);
  };
}

// ===== IMPORTS =====
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');
const Ajv = require('ajv');
const Vec3 = require('vec3');
const fs = require('fs');
const path = require('path');

// Load .env early so process.env values (like GEMINI_API_KEY) are available
try {
	require('dotenv').config();
	console.log('[DEBUG] dotenv: .env loaded (if present)');
} catch (err) {
	console.log('[DEBUG] dotenv not installed — run "npm install dotenv" to enable .env loading');
}

// Node 18+ has global fetch
if (typeof fetch !== 'function') {
  console.error('Your Node does not have global fetch. Use Node 18+ or install node-fetch.');
  process.exit(1);
}

// ===== FILE LOGGING SYSTEM =====
class BotLogger {
  constructor(config) {
    this.config = config;
    this.logFile = config.logging.logFile;
    this.actionCount = 0;
    
    // Create log file if it doesn't exist
    if (config.logging.toFile) {
      this.ensureLogFile();
    }
  }

  ensureLogFile() {
    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, `=== Bot Session Started: ${new Date().toISOString()} ===\n`);
    }
  }

  checkLogRotation() {
    if (!this.config.logging.toFile) return;
    
    try {
      const stats = fs.statSync(this.logFile);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      if (fileSizeMB > this.config.logging.maxFileSizeMB) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveName = `${this.logFile}.${timestamp}`;
        fs.renameSync(this.logFile, archiveName);
        this.ensureLogFile();
        this.log('SYSTEM', `Log rotated to ${archiveName}`);
      }
    } catch (e) {
      console.error('Log rotation error:', e);
    }
  }

  log(category, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      category,
      message,
      data,
      actionCount: this.actionCount
    };

    const logLine = `[${timestamp}] [${category}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;

    // Log to file
    if (this.config.logging.toFile) {
      try {
        fs.appendFileSync(this.logFile, logLine);
        this.checkLogRotation();
      } catch (e) {
        console.error('File logging error:', e);
      }
    }

    // Log to console
    if (this.config.logging.console) {
      console.log(`[${category}] ${message}${data ? ' |' : ''}`, data || '');
    }
  }

  logAction(action, result = 'success', error = null) {
    this.actionCount++;
    this.log('ACTION', `#${this.actionCount} ${action.action}`, {
      action,
      result,
      error: error?.message || error
    });
  }

  logLLM(prompt, response, action) {
    this.log('LLM', 'Decision made', {
      promptLength: prompt.length,
      response: response.slice(0, 200),
      chosenAction: action
    });
  }

  logBot(event, data) {
    this.log('BOT', event, data);
  }

  logSystem(message, data) {
    this.log('SYSTEM', message, data);
  }
}

const logger = new BotLogger(CONFIG);

// Debug environment variable loading
console.log('[DEBUG] GEMINI_API_KEY status:', CONFIG.llm.apiKey ? 'SET' : 'NOT SET');
console.log('[DEBUG] API Key length:', CONFIG.llm.apiKey.length);
if (!CONFIG.llm.apiKey) {
  console.log('[DEBUG] Available env vars starting with GEMINI:', 
    Object.keys(process.env).filter(k => k.startsWith('GEMINI')));
}

// ===== CREATE BOT =====
const bot = mineflayer.createBot({
  host: CONFIG.host,
  port: CONFIG.port,
  username: 'agent',
  version: CONFIG.version,
  auth: CONFIG.auth
});

bot.loadPlugin(pathfinder);

let mcData = null;
let autoModeTimer = null;

bot.once('spawn', () => {
  console.log('[bot] spawn event fired. Version:', bot.version);
  logger.logBot('spawn', { version: bot.version, position: bot.entity?.position });
  
  mcData = require('minecraft-data')(bot.version);
  bot.pathfinder.setMovements(new Movements(bot, mcData));
  console.log(`[bot] connected to ${CONFIG.host}:${CONFIG.port} as ${bot.username}`);
  
  logger.logBot('connected', { 
    host: CONFIG.host, 
    port: CONFIG.port, 
    username: bot.username 
  });

  // Start auto mode if enabled
  if (CONFIG.autoMode.enabled && CONFIG.llm.apiKey) {
    logger.logSystem('Starting auto mode with API key');
    startAutoMode();
  } else if (CONFIG.autoMode.enabled && !CONFIG.llm.apiKey) {
    logger.logSystem('Auto mode disabled: GEMINI_API_KEY not set');
    console.log('[ERROR] To fix this:');
    console.log('[ERROR] 1. In PowerShell: $env:GEMINI_API_KEY="your_actual_api_key"');
    console.log('[ERROR] 2. Or create a .env file with: GEMINI_API_KEY=your_actual_api_key');
    console.log('[ERROR] 3. Then restart the bot');
  }
});

bot.on('end', () => {
  console.log('[bot] connection ended');
  logger.logBot('connection_ended');
  stopAutoMode();
});

bot.on('login', () => {
  console.log('[bot] logged in');
  logger.logBot('logged_in');
});

// Error/kick logs (concise)
bot.on('kicked', (r) => {
  console.log('[bot] KICKED with reason:');
  console.dir(r, { depth: 5 });
  logger.logBot('kicked', r);
  stopAutoMode();
});

bot.on('error', (e) => {
  console.error('[bot] ERROR:', e);
  logger.logBot('error', { message: e.message, stack: e.stack });
});

// ====== STATE HELPERS (minimap + hint) ======
function blockSymbol(block) {
  if (!block) return '?';
  const name = block.name || '';
  if (name.includes('lava')) return '!';
  if (name.includes('water')) return '~';
  if (block.boundingBox === 'block') {
    if (name.includes('log') || name.includes('leaves')) return 'T';
    return '#';
  }
  return '.';
}

function makeMiniMap(botInstance, radius = 5) {
  const e = botInstance.entity;
  if (!e?.position) return '(not ready)';
  const base = e.position;
  const y = Math.floor(base.y) - 1; // feet slice

  const lines = [];
  for (let dz = radius; dz >= -radius; dz--) {
    let row = '';
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dz === 0) { row += '@'; continue; }
      const pos = new Vec3(Math.floor(base.x) + dx, y, Math.floor(base.z) + dz);
      const block = botInstance.blockAt(pos);
      row += blockSymbol(block);
    }
    lines.push(row);
  }

  // Overlay nearby entities as 'M'
  const ents = Object.values(botInstance.entities || {})
    .filter(en => en !== e && en.position)
    .filter(en => Math.abs(en.position.x - base.x) <= radius + 0.5 &&
                  Math.abs(en.position.z - base.z) <= radius + 0.5);
  const grid = lines.map(s => s.split(''));
  ents.forEach(en => {
    const dx = Math.round(en.position.x - Math.floor(base.x));
    const dz = Math.round(en.position.z - Math.floor(base.z));
    const gx = dx + radius;
    const gz = radius - dz;
    if (gz >= 0 && gz < grid.length && gx >= 0 && gx < grid[0].length) grid[gz][gx] = 'M';
  });

  return grid.map(a => a.join('')).join('\n');
}

function dirFromDelta(dx, dz) {
  const ang = Math.atan2(-dz, dx);
  const dirs = ['E','NE','N','NW','W','SW','S','SE'];
  const idx = Math.round(((ang + Math.PI) / (2 * Math.PI)) * 8) % 8;
  return dirs[idx];
}

function buildRenderHint(botInstance) {
  const me = botInstance.entity;
  if (!me?.position) return '';
  const hostiles = ['zombie','skeleton','spider','creeper','enderman','witch'];
  const nearestHostile = Object.values(botInstance.entities)
    .filter(e => e !== me && e.name && hostiles.includes(e.name))
    .map(e => ({ e, d: me.position.distanceTo(e.position) }))
    .sort((a,b)=> a.d - b.d)[0];

  let hostileHint = 'no hostile nearby';
  if (nearestHostile) {
    const dx = nearestHostile.e.position.x - me.position.x;
    const dz = nearestHostile.e.position.z - me.position.z;
    hostileHint = `nearest ${nearestHostile.e.name} at ${nearestHostile.d.toFixed(1)}m ${dirFromDelta(dx,dz)}`;
  }
  const nearWater = botInstance.findBlocks({
    matching: b => b?.name?.includes('water'),
    maxDistance: 8,
    count: 1
  }).length ? 'yes' : 'no';

  return `${hostileHint}; near water: ${nearWater}.`;
}

// ====== BUILD OBSERVATION ======
function blocksAheadSlice(range = 2) {
  const e = bot.entity;
  if (!e?.position) return [];
  const out = [];
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = 1; dz <= range; dz++) {
        const pos = e.position.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        out.push({ dx, dy, dz, id: block?.name || 'air' });
      }
    }
  }
  return out;
}

function buildObservation() {
  const e = bot.entity;
  if (!e) return { ready: false };

  const inv = bot.inventory?.items()?.map(i => ({ item: i.name, count: i.count })) ?? [];
  const hotbar = Array.from({ length: 9 }, (_, slot) => {
    const it = bot.inventory?.slots[36 + slot];
    return { slot, item: it?.name || null, count: it?.count || 0 };
  });

  const entities = Object.values(bot.entities || {})
    .filter(en => en !== e)
    .sort((a, b) => e.position.distanceTo(a.position) - e.position.distanceTo(b.position))
    .slice(0, 12)
    .map(en => ({
      type: en.kind || en.name || 'unknown',
      pos: { x: en.position.x, y: en.position.y, z: en.position.z },
      distance: e.position.distanceTo(en.position)
    }));

  const obs = {
    ready: true,
    position: { x: e.position.x, y: e.position.y, z: e.position.z, yaw: e.yaw, pitch: e.pitch },
    dimension: bot.game?.dimension ?? null,
    timeOfDay: bot.time?.time ?? null,
    biome: bot.game?.biome ?? null,
    health: bot.health ?? null,
    hunger: bot.food ?? null,
    armor: bot.armor ?? null,
    inventory_summary: inv,
    hotbar,
    blocks_ahead: blocksAheadSlice(2),
    nearby_entities: entities,
    minimap_ascii: makeMiniMap(bot, 5),
    render_hint: buildRenderHint(bot)
  };

  if (LOG.stateSummary) {
    console.log(`[state] pos=(${obs.position.x.toFixed(1)},${obs.position.y.toFixed(1)},${obs.position.z.toFixed(1)}) hp=${obs.health} food=${obs.hunger}`);
  }
  return obs;
}

// ====== ACTIONS & VALIDATION ======
const ACTION_JSON_SCHEMA = {
  type: "object",
  required: ["action"],
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["MOVE","LOOK_AT","GOTO","MINE_AT","PLACE_AT","ATTACK_NEAREST","SELECT_HOTBAR","EAT","CRAFT"] },
    horizon_ms: { type: "integer", minimum: 100, maximum: 5000 },
    args: { type: "object", additionalProperties: true }
  }
};
const ajv = new Ajv({ allErrors: true, strict: false });
const validateAction = ajv.compile(ACTION_JSON_SCHEMA);

async function doAction({ action, args = {}, horizon_ms = 400 }) {
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  horizon_ms = clamp(horizon_ms || 400, 100, 5000);

  const { GoalNear } = goals;

  if (LOG.actionExec) console.log('[act] executing', JSON.stringify({ action, args, horizon_ms }));
  logger.logAction({ action, args, horizon_ms }, 'started');

  try {
    switch (action) {
      case 'MOVE': {
        // args: {forward?, back?, left?, right?, jump?, ms?}
        const ms = clamp(args.ms ?? horizon_ms, 100, 3000);
        const keys = ['forward','back','left','right','jump'];
        keys.forEach(k => bot.setControlState(k, !!args[k]));
        await new Promise(r => setTimeout(r, ms));
        keys.forEach(k => bot.setControlState(k, false));
        break;
      }
      case 'LOOK_AT': {
        const { x, y, z, force = true } = args;
        if ([x,y,z].some(v => typeof v !== 'number')) throw new Error('LOOK_AT requires numeric x,y,z');
        await bot.lookAt({ x, y, z }, force);
        break;
      }
      case 'GOTO': {
        const { x, y, z, radius = 1 } = args;
        if ([x,y,z].some(v => typeof v !== 'number')) throw new Error('GOTO requires x,y,z');
        bot.pathfinder.setGoal(new GoalNear(x, y, z, radius));
        break;
      }
      case 'MINE_AT': {
        const { x, y, z } = args;
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) throw new Error('No block at coords');
        await bot.dig(block);
        break;
      }
      case 'PLACE_AT': {
        const { x, y, z, hand = 'right' } = args;
        const ref = bot.blockAt(new Vec3(x, y, z));
        if (!ref) throw new Error('No reference block at coords');
        await bot.placeBlock(ref, { x: 0, y: 1, z: 0 }, hand);
        break;
      }
      case 'ATTACK_NEAREST': {
        const range = args.range ?? 3.5;
        const allow = args.types;
        const me = bot.entity;
        const target = Object.values(bot.entities)
          .filter(e => e !== me && e.position && me.position.distanceTo(e.position) <= range)
          .filter(e => !allow || allow.includes(e.name || e.kind))
          .sort((a,b)=> me.position.distanceTo(a.position) - me.position.distanceTo(b.position))[0];
        if (target) {
          await bot.attack(target);
          logger.logAction({ action, args }, 'success', `attacked ${target.name || target.kind}`);
        } else {
          if (LOG.actionExec) console.log('[act] no target in range');
          logger.logAction({ action, args }, 'no_target');
        }
        break;
      }
      case 'SELECT_HOTBAR': {
        const slot = args.slot ?? 0;
        if (slot < 0 || slot > 8) throw new Error('slot must be 0..8');
        bot.setQuickBarSlot(slot);
        break;
      }
      case 'EAT': {
        const edible = bot.inventory.items().find(i => i.foodPoints);
        if (!edible) { 
          if (LOG.actionExec) console.log('[act] no food in inventory'); 
          logger.logAction({ action, args }, 'no_food');
          break; 
        }
        await bot.equip(edible, 'hand');
        await bot.consume();
        break;
      }
      case 'CRAFT': {
        if (!mcData) throw new Error('mcData not ready');
        const { itemName, count = 1, useTable = false } = args;
        const item = mcData.itemsByName[itemName];
        if (!item) throw new Error('Unknown item: ' + itemName);
        const recipes = bot.recipesFor(item.id, null, 1, useTable);
        if (!recipes.length) throw new Error('No recipe found (maybe need crafting table)');
        await bot.craft(recipes[0], count, null);
        break;
      }
      default:
        throw new Error('Unknown action: ' + action);
    }

    if (LOG.actionExec) console.log('[act] done', action);
    logger.logAction({ action, args, horizon_ms }, 'completed');
  } catch (error) {
    logger.logAction({ action, args, horizon_ms }, 'failed', error);
    throw error;
  }
}

// ====== PROMPT BUILDER ======
function buildPrompt(observation, goal = CONFIG.defaultGoal) {
  const legend = 'Legend: @=self, #=solid, .=walkable, ~=water, !=lava, T=tree, M=mob, ?=unknown.';
  const rules = [
    'Choose ONE action JSON from the schema. No text, no markdown.',
    'Avoid lava (!). Prefer walkable (.). Keep distance from mobs unless attacking.',
    'If hunger < 7, choose EAT. Use GOTO for navigation, not long MOVE chains.',
    'Use horizon_ms 200–800 unless crafting/mining needs longer.'
  ].join(' ');

  const fewshot = `
Examples (Return only one JSON object):
{"action":"MOVE","args":{"forward":true,"ms":500},"horizon_ms":500}
{"action":"EAT","args":{},"horizon_ms":400}
{"action":"GOTO","args":{"x":${Math.round(observation.position.x)+2},"y":${Math.round(observation.position.y)},"z":${Math.round(observation.position.z)},"radius":2},"horizon_ms":400}
`.trim();

  return `
You are a Minecraft planner. Output exactly ONE JSON action matching this schema:
{"action":"MOVE|LOOK_AT|GOTO|MINE_AT|PLACE_AT|ATTACK_NEAREST|SELECT_HOTBAR|EAT|CRAFT","args":{...},"horizon_ms":400}

${legend}
${rules}

Goal: ${goal}

Observation:
- pos: ${JSON.stringify(observation.position)}
- hp/hunger: ${observation.health}/${observation.hunger}
- hint: ${observation.render_hint || "none"}
- inv: ${JSON.stringify(observation.inventory_summary.slice(0,6))}
- minimap:
${observation.minimap_ascii || "(none)"}

${fewshot}

Return ONLY the JSON object for the chosen action, no commentary.
`.trim();
}

// ====== AUTO MODE FUNCTIONS ======
async function executeLLMDecision(goal = CONFIG.defaultGoal) {
  try {
    if (!CONFIG.llm.apiKey) {
      logger.logSystem('Cannot execute LLM decision: GEMINI_API_KEY not set');
      return false;
    }

    if (logger.actionCount >= CONFIG.autoMode.maxActions) {
      logger.logSystem(`Reached max actions limit (${CONFIG.autoMode.maxActions}), stopping auto mode`);
      stopAutoMode();
      return false;
    }

    const obs = buildObservation();
    if (!obs.ready) {
      logger.logSystem('Bot not ready for LLM decision');
      return false;
    }

    const prompt = buildPrompt(obs, goal);

    if (LOG.promptPreview) {
      const preview = prompt.replace(/\s+/g, ' ').slice(0, 240);
      console.log('[llm] prompt preview:', preview + ' ...');
    }

    const url = `${CONFIG.llm.url}?key=${encodeURIComponent(CONFIG.llm.apiKey)}`;
    const llmReq = {
      contents: [{ parts: [{ text: prompt }]}],
      generationConfig: { maxOutputTokens: CONFIG.llm.maxTokens }
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(llmReq)
    });

    const rawText = await resp.text();
    if (!resp.ok) {
      logger.logSystem(`LLM HTTP error ${resp.status}`, rawText.slice(0, 300));
      return false;
    }

    let data;
    try { data = JSON.parse(rawText); }
    catch (_) {
      logger.logSystem('LLM returned non-JSON response', rawText.slice(0, 300));
      return false;
    }

    const modelText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (LOG.llmText) console.log('[llm] text:', modelText.split('\n')[0]?.slice(0, 300));

    const match = modelText.match(/\{[\s\S]*\}$/m);
    if (!match) {
      logger.logSystem('No JSON found in LLM response', modelText.slice(0, 300));
      return false;
    }

    let action;
    try { action = JSON.parse(match[0]); }
    catch (e) {
      logger.logSystem('Invalid JSON from LLM', { error: e.message, text: modelText.slice(0, 300) });
      return false;
    }

    if (!validateAction(action)) {
      logger.logSystem('LLM action failed validation', { errors: validateAction.errors, action });
      return false;
    }

    logger.logLLM(prompt, modelText, action);
    
    if (LOG.actionExec) console.log('[act] LLM chose:', action);
    await doAction(action);
    if (LOG.actionExec) console.log('[act] executed');

    return true;
  } catch (e) {
    logger.logSystem('LLM decision error', { error: e.message, stack: e.stack });
    return false;
  }
}

function startAutoMode() {
  if (autoModeTimer) {
    clearInterval(autoModeTimer);
  }
  
  logger.logSystem('Auto mode started', {
    intervalMs: CONFIG.autoMode.intervalMs,
    maxActions: CONFIG.autoMode.maxActions,
    goal: CONFIG.defaultGoal
  });

  autoModeTimer = setInterval(async () => {
    if (bot.entity && bot.entity.position) {
      await executeLLMDecision();
    }
  }, CONFIG.autoMode.intervalMs);
}

function stopAutoMode() {
  if (autoModeTimer) {
    clearInterval(autoModeTimer);
    autoModeTimer = null;
    logger.logSystem('Auto mode stopped');
  }
}

// ====== EXPRESS API ======
const app = express();
app.use(express.json());

app.get('/state', (_req, res) => {
  try {
    const obs = buildObservation();
    res.json(obs);
  } catch (e) {
    console.error('[state] error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/act', async (req, res) => {
  try {
    const action = req.body || {};
    if (!validateAction(action)) {
      console.warn('[act] invalid schema:', validateAction.errors);
      return res.status(400).json({ ok: false, error: 'Invalid action JSON', details: validateAction.errors });
    }
    await doAction(action);
    res.json({ ok: true });
  } catch (e) {
    console.error('[act] error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/decide', async (req, res) => {
  try {
    if (!CONFIG.llm.apiKey) {
      return res.status(400).json({ ok: false, error: 'GEMINI_API_KEY not set in environment' });
    }
    const goal = req.body?.goal || CONFIG.defaultGoal;
    const success = await executeLLMDecision(goal);
    
    if (success) {
      res.json({ ok: true, message: 'LLM decision executed successfully' });
    } else {
      res.status(500).json({ ok: false, error: 'LLM decision failed' });
    }
  } catch (e) {
    console.error('[decide] error:', e);
    logger.logSystem('Manual LLM decision error', { error: e.message });
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/auto/start', (req, res) => {
  try {
    if (!CONFIG.llm.apiKey) {
      return res.status(400).json({ ok: false, error: 'GEMINI_API_KEY not set' });
    }
    CONFIG.autoMode.enabled = true;
    if (req.body?.goal) {
      CONFIG.defaultGoal = req.body.goal;
    }
    startAutoMode();
    res.json({ ok: true, message: 'Auto mode started', goal: CONFIG.defaultGoal });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/auto/stop', (req, res) => {
  try {
    CONFIG.autoMode.enabled = false;
    stopAutoMode();
    res.json({ ok: true, message: 'Auto mode stopped' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/auto/status', (req, res) => {
  res.json({
    enabled: CONFIG.autoMode.enabled,
    running: autoModeTimer !== null,
    intervalMs: CONFIG.autoMode.intervalMs,
    maxActions: CONFIG.autoMode.maxActions,
    currentActions: logger.actionCount,
    goal: CONFIG.defaultGoal,
    hasApiKey: !!CONFIG.llm.apiKey
  });
});

app.get('/logs', (req, res) => {
  try {
    const lines = req.query.lines ? parseInt(req.query.lines) : 100;
    if (!CONFIG.logging.toFile || !fs.existsSync(CONFIG.logging.logFile)) {
      return res.json({ ok: false, error: 'Log file not found' });
    }
    
    const logContent = fs.readFileSync(CONFIG.logging.logFile, 'utf8');
    const logLines = logContent.split('\n').filter(line => line.trim());
    const recentLines = logLines.slice(-lines);
    
    res.json({ 
      ok: true, 
      lines: recentLines, 
      totalActions: logger.actionCount,
      logFile: CONFIG.logging.logFile
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/debug/prompt', (_req, res) => {
  try {
    const obs = buildObservation();
    const p = buildPrompt(obs, CONFIG.defaultGoal);
    res.type('text/plain').send(p);
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

app.listen(CONFIG.apiPort, () => {
  console.log(`[api] http://localhost:${CONFIG.apiPort}/state`);
  console.log(`[api] POST /act   (send {"action": "...", "args": {...}})`);
  console.log(`[api] POST /decide (body: {"goal": "..."}) -> calls LLM + executes`);
  console.log(`[api] POST /auto/start (body: {"goal": "..."}) -> starts auto mode`);
  console.log(`[api] POST /auto/stop -> stops auto mode`);
  console.log(`[api] GET /auto/status -> auto mode status`);
  console.log(`[api] GET /logs?lines=100 -> recent log entries`);
  
  logger.logSystem('API server started', {
    port: CONFIG.apiPort,
    autoMode: CONFIG.autoMode.enabled,
    logging: CONFIG.logging.toFile ? CONFIG.logging.logFile : 'console only'
  });
});
