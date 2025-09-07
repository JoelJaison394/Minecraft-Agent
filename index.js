// ===== CONFIG =====
const CONFIG = {
  host: '192.168.1.9',
  port: 25565,
  version: '1.20.4',   
  auth: 'offline',
  apiPort: 3000,
  llm: {
    // LM Studio local server - no API key needed for local setup
    apiKey: '', // Not needed for local LM Studio
    url: 'http://localhost:1234/v1/chat/completions',
    model: 'gemma-3-4b-it',
    maxTokens: 1000,     // Increased for better responses
    temperature: 0.7,
  },
  defaultGoal: 'find and mine trees to collect wood blocks', // <— your default LLM goal
  autoMode: {
    enabled: true,        // Auto-execute LLM decisions
    intervalMs: 5000,     // Increased to 5 seconds for action completion
    maxActions: 1000      // Safety limit
  },
  actionHistory: {
    maxHistory: 15,       // Increased history for better context
    includeResults: true  // Include action results/outcomes
  },
  actionSync: {
    enabled: true,        // Wait for actions to complete before next LLM call
    miningTimeout: 30000, // 30 seconds max for mining operations
    movementTimeout: 10000, // 10 seconds max for movement
    defaultTimeout: 15000   // 15 seconds default timeout
  },
  mapping: {
    radius: 16,          // Full chunk overview (32x32 area)
    includeBlockTypes: true, // Include detailed block information
    verticalRange: 5,    // Check blocks above/below
    showCoordinates: true, // Show important block coordinates
    chunkOverview: true   // Show chunk-level mapping
  },
  logging: {
    toFile: true,         // Enable file logging
    logFile: 'bot-actions.log',
    console: true,        // Also log to console
    maxFileSizeMB: 50,    // Rotate log when it gets too big
    separateFiles: {
      maps: 'bot-maps.log',
      prompts: 'bot-prompts.log', 
      gameState: 'bot-gamestate.log'
    }
  },
  movement: {
    waterDetection: true,     // Enable water detection and swimming
    ticksPerBlock: 20,        // Approximate ticks to move one block (walking)
    swimTicksPerBlock: 25,    // Ticks to move one block while swimming
    safetyMargin: 1.2,        // Safety multiplier for time calculations
    maxWaterDistance: 10,     // Max distance to swim before finding land
    landSearchRadius: 15      // Radius to search for nearest land
  },
  // ===== NEW: BEHAVIORAL INTELLIGENCE SYSTEM =====
  intelligence: {
    behavioralOverrides: true, // Enable smart behavior overrides
    stuckDetectionThreshold: 3, // Number of same actions to consider "stuck"
    proximityMiningDistance: 3, // Auto-mine trees within this distance
    explorationDistance: 30, // Distance to explore when no objectives found
    contextAwareness: true, // Enable context-aware decision making
    proactiveActions: true, // Enable proactive behavior (auto-mining, auto-exploring)
    memoryDepth: 50, // Remember last 50 actions for pattern detection
    smartTransitions: true, // Enable smart state transitions
    overrideRepeatedActions: true // Override when LLM repeats same action too much
  },
  // ===== NEW: MOB-LIKE AI GOAL SYSTEM =====
  goalSystem: {
    enabled: true, // Enable goal-based AI system
    maxActiveGoals: 3, // Maximum concurrent goals
    tickInterval: 100, // Goal evaluation interval in ms (10 times per second)
    senseRadius: 16, // Entity/block sensing radius
    llmValidationInterval: 5000, // LLM validates/enhances goals every 5 seconds
    goalPersistence: 30000, // Goals persist for 30 seconds unless completed/failed
    adaptivePriority: true, // Allow dynamic priority adjustment based on world state
    emergencyOverride: true // Allow emergency goals to interrupt others
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

// ===== MINING HELPERS =====
async function approachBlock(bot, blockPos, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const g = new goals.GoalGetToBlock(blockPos.x, blockPos.y, blockPos.z)
    let timer = setTimeout(() => {
      bot.pathfinder.setGoal(null)
      reject(new Error('path timeout'))
    }, timeoutMs)

    function done(ok) {
      clearTimeout(timer)
      bot.removeListener('goal_reached', onReached)
      bot.removeListener('path_update', onUpdate)
      bot.pathfinder.setGoal(null)
      ok ? resolve() : reject(new Error('no path'))
    }
    function onReached() { done(true) }
    function onUpdate(r) {
      if (r.status === 'noPath' || r.status === 'timeout') done(false)
    }

    bot.on('goal_reached', onReached)
    bot.on('path_update', onUpdate)
    bot.pathfinder.setGoal(g)
  })
}

async function settleBeforeDig(bot) {
  // fully stop movement and rotations that can abort digging
  bot.pathfinder.setGoal(null)
  bot.pathfinder.stop()
  bot.clearControlStates()
  await bot.waitForTicks(2)

  // tiny head-nudge to "lock" view at the block
  const vel = bot.entity.velocity
  const moving = Math.abs(vel.x) + Math.abs(vel.y) + Math.abs(vel.z) > 0.001
  if (moving) await bot.waitForTicks(4)
}

async function safeDig(bot, block, perBlockTimeoutMs = 8000) {
  // never start new dig while one is running
  try { bot.stopDigging() } catch {}
  await bot.waitForTicks(1)

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      cleanup()
      reject(new Error('Mining timeout'))
    }, perBlockTimeoutMs)

    function cleanup() {
      clearTimeout(timer)
      bot.removeListener('diggingCompleted', onDone)
      bot.removeListener('diggingAborted', onAbort)
    }
    function onDone(dug) {
      if (dug.position.equals(block.position)) { cleanup(); resolve() }
    }
    function onAbort(dug) {
      if (dug.position.equals(block.position)) {
        cleanup()
        reject(new Error('Digging aborted'))
      }
    }
    bot.on('diggingCompleted', onDone)
    bot.on('diggingAborted', onAbort)

    // start digging; if enchants getter still throws anywhere, catch and retry
    bot.dig(block, true).catch(err => reject(err))
  })
}

// 🔧 PATCH: Fix enchants error for unsupported MC versions
const ItemLoader = require('prismarine-item');

function patchPrismarineItemVariants(versions) {
  for (const ver of versions) {
    try {
      const Item = ItemLoader(ver)
      const desc = Object.getOwnPropertyDescriptor(Item.prototype, 'enchants')
      if (!desc || typeof desc.get !== 'function') continue
      const originalGet = desc.get
      Object.defineProperty(Item.prototype, 'enchants', {
        configurable: true,
        enumerable: true,
        get() {
          try { return originalGet.call(this) } catch { return [] } // <-- no throw
        }
      })
      console.log(`[PATCH] enchants getter patched for "${ver}"`)
    } catch (e) {
      console.log(`[PATCH] failed for "${ver}": ${e.message}`)
    }
  }
}

// Load .env early so process.env values are available if needed
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

// ===== ACTION HISTORY STORAGE =====
const actionHistory = [];
let currentAction = null; // Track ongoing action
let actionStartTime = null;

// ===== BEHAVIORAL INTELLIGENCE TRACKING =====
const botIntelligence = {
  actionMemory: [], // Remember recent actions for pattern detection
  lastPositions: [], // Track position history for stuck detection
  consecutiveActions: {}, // Count consecutive identical actions
  lastLLMDecision: null, // Track last LLM decision
  contextState: {
    nearTreeBlocks: [],
    currentObjective: null,
    stuckCount: 0,
    lastOverrideTime: 0
  },
  behaviorFlags: {
    isStuck: false,
    shouldOverride: false,
    isExploring: false,
    isMining: false
  }
};

// ===== MOB-LIKE GOAL SYSTEM =====
class Goal {
  constructor(bot, priority = 1, name = 'GenericGoal') {
    this.bot = bot;
    this.priority = priority;
    this.name = name;
    this.isActive = false;
    this.startTime = null;
    this.lastTickTime = null;
    this.targetEntity = null;
    this.targetPosition = null;
    this.metadata = {};
  }

  // Check if this goal can be activated
  canUse() {
    return false; // Override in subclasses
  }

  // Check if this goal should continue running
  canContinue() {
    return this.isActive;
  }

  // Start executing this goal
  start() {
    this.isActive = true;
    this.startTime = Date.now();
    console.log(`[GOAL] Starting ${this.name} (priority: ${this.priority})`);
  }

  // Stop executing this goal
  stop() {
    this.isActive = false;
    this.startTime = null;
    console.log(`[GOAL] Stopping ${this.name}`);
  }

  // Execute one tick of this goal
  tick() {
    if (!this.isActive) return;
    this.lastTickTime = Date.now();
    // Override in subclasses
  }

  // Get dynamic priority based on current world state
  getDynamicPriority() {
    return this.priority;
  }

  // Check if goal has timed out
  hasTimedOut() {
    if (!this.startTime) return false;
    return Date.now() - this.startTime > CONFIG.goalSystem.goalPersistence;
  }
}

class GoalSelector {
  constructor(bot) {
    this.bot = bot;
    this.goals = [];
    this.activeGoals = [];
    this.lastTickTime = 0;
    this.sensorData = {
      nearbyPlayers: [],
      nearbyMobs: [],
      nearbyBlocks: {},
      inventory: {},
      health: 20,
      hunger: 20
    };
  }

  // Add a goal to the selector
  addGoal(goal) {
    this.goals.push(goal);
    this.goals.sort((a, b) => b.getDynamicPriority() - a.getDynamicPriority());
  }

  // Remove a goal from the selector
  removeGoal(goalName) {
    this.goals = this.goals.filter(g => g.name !== goalName);
    this.activeGoals = this.activeGoals.filter(g => g.name !== goalName);
  }

  // Update sensor data
  updateSensors() {
    const pos = this.bot.entity.position;
    const radius = CONFIG.goalSystem.senseRadius;

    // Detect nearby players
    this.sensorData.nearbyPlayers = Object.values(this.bot.players)
      .filter(p => p.entity && p.entity.position.distanceTo(pos) <= radius)
      .map(p => ({
        username: p.username,
        position: p.entity.position.clone(),
        distance: p.entity.position.distanceTo(pos)
      }));

    // Detect nearby mobs
    this.sensorData.nearbyMobs = Object.values(this.bot.entities)
      .filter(e => e.type === 'mob' && e.position.distanceTo(pos) <= radius)
      .map(e => ({
        type: e.name,
        position: e.position.clone(),
        distance: e.position.distanceTo(pos),
        health: e.health,
        isHostile: this.isHostileMob(e.name)
      }));

    // Detect nearby valuable blocks
    this.sensorData.nearbyBlocks = this.scanNearbyBlocks(pos, radius);

    // Update bot status
    this.sensorData.inventory = this.getInventorySummary();
    this.sensorData.health = this.bot.health;
    this.sensorData.hunger = this.bot.food;
  }

  // Scan for valuable blocks (trees, ores, etc.)
  scanNearbyBlocks(centerPos, radius) {
    const blocks = {
      trees: [],
      ores: [],
      resources: [],
      hazards: []
    };

    for (let x = -radius; x <= radius; x++) {
      for (let y = -8; y <= 8; y++) {
        for (let z = -radius; z <= radius; z++) {
          const blockPos = centerPos.clone().offset(x, y, z);
          const block = this.bot.blockAt(blockPos);
          if (!block || block.name === 'air') continue;

          const distance = centerPos.distanceTo(blockPos);
          if (distance > radius) continue;

          if (this.isTreeBlock(block)) {
            blocks.trees.push({ position: blockPos, type: block.name, distance });
          } else if (this.isOreBlock(block)) {
            blocks.ores.push({ position: blockPos, type: block.name, distance });
          } else if (this.isResourceBlock(block)) {
            blocks.resources.push({ position: blockPos, type: block.name, distance });
          } else if (this.isHazardBlock(block)) {
            blocks.hazards.push({ position: blockPos, type: block.name, distance });
          }
        }
      }
    }

    // Sort by distance
    Object.keys(blocks).forEach(key => {
      blocks[key].sort((a, b) => a.distance - b.distance);
    });

    return blocks;
  }

  // Helper methods for block classification
  isTreeBlock(block) { return block.name.includes('log') || block.name.includes('wood'); }
  isOreBlock(block) { return block.name.includes('ore') || block.name === 'coal_ore' || block.name === 'iron_ore'; }
  isResourceBlock(block) { return ['stone', 'dirt', 'sand', 'gravel'].some(type => block.name.includes(type)); }
  isHazardBlock(block) { return ['lava', 'fire', 'magma'].some(type => block.name.includes(type)); }
  isHostileMob(mobName) { return ['zombie', 'skeleton', 'spider', 'creeper', 'enderman'].includes(mobName); }

  getInventorySummary() {
    const summary = { wood: 0, stone: 0, food: 0, tools: 0, total: 0 };
    this.bot.inventory.items().forEach(item => {
      summary.total++;
      if (item.name.includes('log') || item.name.includes('wood')) summary.wood++;
      else if (item.name.includes('stone') || item.name.includes('cobblestone')) summary.stone++;
      else if (item.name.includes('bread') || item.name.includes('meat')) summary.food++;
      else if (item.name.includes('pickaxe') || item.name.includes('axe') || item.name.includes('shovel')) summary.tools++;
    });
    return summary;
  }

  // Main tick function - mob AI brain
  tick() {
    const now = Date.now();
    if (now - this.lastTickTime < CONFIG.goalSystem.tickInterval) return;
    this.lastTickTime = now;

    // Update world sensors
    this.updateSensors();

    // Remove timed out or completed goals
    this.activeGoals = this.activeGoals.filter(goal => {
      if (goal.hasTimedOut() || !goal.canContinue()) {
        goal.stop();
        return false;
      }
      return true;
    });

    // Find new goals that can be activated
    const availableGoals = this.goals.filter(goal => 
      !this.activeGoals.includes(goal) && goal.canUse()
    );

    // Sort by dynamic priority
    availableGoals.sort((a, b) => b.getDynamicPriority() - a.getDynamicPriority());

    // Activate high-priority goals if we have capacity
    while (this.activeGoals.length < CONFIG.goalSystem.maxActiveGoals && availableGoals.length > 0) {
      const goal = availableGoals.shift();
      goal.start();
      this.activeGoals.push(goal);
    }

    // Tick all active goals
    this.activeGoals.forEach(goal => goal.tick());
  }

  // Get current status for LLM validation
  getStatus() {
    return {
      sensorData: this.sensorData,
      activeGoals: this.activeGoals.map(g => ({ name: g.name, priority: g.getDynamicPriority() })),
      goalCount: this.goals.length
    };
  }
}

// Global goal system instance
let goalSystem = null;

function addToActionHistory(action, result, error = null) {
  const historyEntry = {
    timestamp: new Date().toISOString(),
    action: action,
    result: result,
    error: error,
    actionNumber: actionHistory.length + 1,
    duration: actionStartTime ? Date.now() - actionStartTime : 0
  };
  
  actionHistory.push(historyEntry);
  
  // Enhanced tracking for behavioral intelligence
  if (CONFIG.intelligence.behavioralOverrides) {
    // Track mining failures specifically
    if ((action.action === 'MINE_TREE' || action.action === 'MINE_AT') && 
        (result === 'failed' || error || result.includes('Error') || result.includes('0/') || result.includes('Completed! Mined 0'))) {
      console.log(`[INTELLIGENCE] ❌ Mining failure detected: ${action.action} - ${result}`);
    }
  }
  
  // Keep only the last N actions
  if (actionHistory.length > CONFIG.actionHistory.maxHistory) {
    actionHistory.shift();
  }
}

function getActionHistoryForPrompt() {
  if (actionHistory.length === 0) {
    return "No previous actions taken yet.";
  }
  
  // Check for stuck patterns
  const recentActions = actionHistory.slice(-5);
  const sameLocationCount = recentActions.filter(entry => {
    return entry.action.action === 'GOTO' && entry.result === 'completed' && entry.duration < 1000;
  }).length;
  
  let historyText = actionHistory.map(entry => {
    let historyLine = `${entry.actionNumber}. ${entry.action.action}`;
    if (entry.action.args && Object.keys(entry.action.args).length > 0) {
      historyLine += ` (${JSON.stringify(entry.action.args)})`;
    }
    historyLine += ` -> ${entry.result}`;
    if (entry.duration > 0) {
      historyLine += ` [${(entry.duration/1000).toFixed(1)}s]`;
    }
    if (entry.error) {
      historyLine += ` [ERROR: ${entry.error}]`;
    }
    return historyLine;
  }).join('\n');
  
  // Add warning if stuck
  if (sameLocationCount >= 3) {
    historyText += '\n\n⚠️  WARNING: You appear to be stuck! Multiple recent GOTO actions completed instantly, suggesting you\'re trying to go to the same location repeatedly. You need to explore a different area!';
  }
  
  return historyText;
}

function isActionInProgress() {
  return currentAction !== null;
}

// ===== WATER AND MOVEMENT DETECTION =====
function isInWater(botInstance) {
  const playerPos = botInstance.entity.position;
  const blockAtPlayer = botInstance.blockAt(playerPos);
  const blockAbovePlayer = botInstance.blockAt(playerPos.offset(0, 1, 0));
  
  return (blockAtPlayer && blockAtPlayer.name.includes('water')) ||
         (blockAbovePlayer && blockAbovePlayer.name.includes('water'));
}

function calculateMovementTime(fromPos, toPos, inWater = false) {
  const distance = Math.sqrt(
    Math.pow(toPos.x - fromPos.x, 2) + 
    Math.pow(toPos.y - fromPos.y, 2) + 
    Math.pow(toPos.z - fromPos.z, 2)
  );
  
  const ticksPerBlock = inWater ? CONFIG.movement.swimTicksPerBlock : CONFIG.movement.ticksPerBlock;
  const estimatedTicks = distance * ticksPerBlock * CONFIG.movement.safetyMargin;
  
  // Convert ticks to milliseconds (20 ticks = 1 second)
  return Math.ceil(estimatedTicks * 50); // 50ms per tick
}

function findNearestLand(botInstance, radius = CONFIG.movement.landSearchRadius) {
  const playerPos = botInstance.entity.position;
  const candidates = [];
  
  // Search in a spiral pattern
  for (let r = 1; r <= radius; r++) {
    for (let angle = 0; angle < 360; angle += 15) {
      const radian = (angle * Math.PI) / 180;
      const x = Math.round(playerPos.x + r * Math.cos(radian));
      const z = Math.round(playerPos.z + r * Math.sin(radian));
      
      // Check for solid ground at water level
      for (let y = Math.floor(playerPos.y) - 2; y <= Math.floor(playerPos.y) + 2; y++) {
        const groundBlock = botInstance.blockAt(new Vec3(x, y, z));
        const aboveBlock = botInstance.blockAt(new Vec3(x, y + 1, z));
        
        if (groundBlock && groundBlock.name !== 'air' && !groundBlock.name.includes('water') &&
            aboveBlock && (aboveBlock.name === 'air' || !aboveBlock.name.includes('water'))) {
          candidates.push({ x, y: y + 1, z, distance: r });
          break;
        }
      }
    }
    
    if (candidates.length > 0) {
      // Return closest land position
      candidates.sort((a, b) => a.distance - b.distance);
      return candidates[0];
    }
  }
  
  return null;
}

function pathRequiresSwimming(botInstance, fromPos, toPos) {
  const steps = 10; // Check path in 10 steps
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const checkPos = {
      x: fromPos.x + (toPos.x - fromPos.x) * progress,
      y: fromPos.y + (toPos.y - fromPos.y) * progress,
      z: fromPos.z + (toPos.z - fromPos.z) * progress
    };
    
    const block = botInstance.blockAt(new Vec3(Math.floor(checkPos.x), Math.floor(checkPos.y), Math.floor(checkPos.z)));
    if (block && block.name.includes('water')) {
      return true;
    }
  }
  return false;
}

// ===== BEHAVIORAL INTELLIGENCE FUNCTIONS =====

// Track action patterns and detect stuck behavior
function updateActionMemory(action) {
  const actionKey = `${action.type}_${JSON.stringify(action.parameters || {})}`;
  botIntelligence.actionMemory.push({
    key: actionKey,
    timestamp: Date.now(),
    action: action
  });
  
  // Keep only recent actions
  if (botIntelligence.actionMemory.length > CONFIG.intelligence.memoryDepth) {
    botIntelligence.actionMemory.shift();
  }
  
  // Update consecutive action counter
  botIntelligence.consecutiveActions[actionKey] = (botIntelligence.consecutiveActions[actionKey] || 0) + 1;
  
  // Clear counters for other actions
  Object.keys(botIntelligence.consecutiveActions).forEach(key => {
    if (key !== actionKey) {
      botIntelligence.consecutiveActions[key] = 0;
    }
  });
}

// Check if bot is stuck in repetitive behavior
function detectStuckBehavior() {
  if (!CONFIG.intelligence.behavioralOverrides) return false;
  
  const recentActions = botIntelligence.actionMemory.slice(-CONFIG.intelligence.stuckDetectionThreshold);
  if (recentActions.length < CONFIG.intelligence.stuckDetectionThreshold) return false;
  
  // Check if all recent actions are the same
  const actionKeys = recentActions.map(a => a.key);
  const allSame = actionKeys.every(key => key === actionKeys[0]);
  
  if (allSame) {
    console.log(`[INTELLIGENCE] 🤖 Detected stuck behavior: repeated "${actionKeys[0]}" ${actionKeys.length} times`);
    botIntelligence.behaviorFlags.isStuck = true;
    botIntelligence.contextState.stuckCount++;
    return true;
  }
  
  return false;
}

// Get intelligent action override when LLM is stuck
function getIntelligentOverride(botInstance) {
  if (!CONFIG.intelligence.behavioralOverrides || !botIntelligence.behaviorFlags.isStuck) {
    return null;
  }
  
  const currentPos = botInstance.entity.position;
  console.log(`[INTELLIGENCE] 🧠 Analyzing context for intelligent override...`);
  
  // Check for recent mining failures
  const recentActions = botIntelligence.actionMemory.slice(-5);
  const recentMiningFailures = recentActions.filter(a => 
    (a.action.action === 'MINE_TREE' || a.action.action === 'MINE_AT') && 
    Date.now() - a.timestamp < 60000 // Within last minute
  );
  
  if (recentMiningFailures.length >= 3) {
    console.log(`[INTELLIGENCE] ⚠️ Detected repeated mining failures - trying exploration instead`);
    
    // Force exploration instead of more mining attempts
    const exploreDirection = Math.random() * 2 * Math.PI;
    const exploreDistance = CONFIG.intelligence.explorationDistance;
    const targetX = currentPos.x + Math.cos(exploreDirection) * exploreDistance;
    const targetZ = currentPos.z + Math.sin(exploreDirection) * exploreDistance;
    
    botIntelligence.behaviorFlags.shouldOverride = true;
    botIntelligence.behaviorFlags.isExploring = true;
    botIntelligence.contextState.lastOverrideTime = Date.now();
    
    // Reset stuck state
    botIntelligence.behaviorFlags.isStuck = false;
    Object.keys(botIntelligence.consecutiveActions).forEach(key => {
      botIntelligence.consecutiveActions[key] = 0;
    });
    
    return {
      action: 'GOTO',
      args: {
        x: Math.round(targetX),
        y: currentPos.y,
        z: Math.round(targetZ),
        radius: 3
      },
      horizon_ms: 1200
    };
  }
  
  // Check for nearby trees that can be mined
  const nearbyTreeBlocks = [];
  const searchRadius = CONFIG.intelligence.proximityMiningDistance;
  
  for (let x = -searchRadius; x <= searchRadius; x++) {
    for (let y = -2; y <= 2; y++) {
      for (let z = -searchRadius; z <= searchRadius; z++) {
        const blockPos = currentPos.clone().offset(x, y, z);
        const block = botInstance.blockAt(blockPos);
        if (block && isTreeBlock(block)) {
          nearbyTreeBlocks.push(block);
        }
      }
    }
  }
  
  if (nearbyTreeBlocks.length > 0) {
    console.log(`[INTELLIGENCE] 🌳 Found ${nearbyTreeBlocks.length} tree blocks nearby - initiating intelligent mining`);
    botIntelligence.behaviorFlags.shouldOverride = true;
    botIntelligence.contextState.lastOverrideTime = Date.now();
    
    // Reset stuck state since we're taking action
    botIntelligence.behaviorFlags.isStuck = false;
    Object.keys(botIntelligence.consecutiveActions).forEach(key => {
      botIntelligence.consecutiveActions[key] = 0;
    });
    
    // Return intelligent mining action
    return {
      action: 'MINE_TREE',
      args: {
        x: nearbyTreeBlocks[0].position.x,
        y: nearbyTreeBlocks[0].position.y,
        z: nearbyTreeBlocks[0].position.z
      },
      horizon_ms: 10000
    };
  }
  
  // If no trees nearby, try exploration
  if (CONFIG.intelligence.proactiveActions) {
    console.log(`[INTELLIGENCE] 🔍 No trees nearby - initiating intelligent exploration`);
    const exploreDirection = Math.random() * 2 * Math.PI;
    const exploreDistance = CONFIG.intelligence.explorationDistance;
    const targetX = currentPos.x + Math.cos(exploreDirection) * exploreDistance;
    const targetZ = currentPos.z + Math.sin(exploreDirection) * exploreDistance;
    
    botIntelligence.behaviorFlags.shouldOverride = true;
    botIntelligence.behaviorFlags.isExploring = true;
    botIntelligence.contextState.lastOverrideTime = Date.now();
    
    // Reset stuck state
    botIntelligence.behaviorFlags.isStuck = false;
    Object.keys(botIntelligence.consecutiveActions).forEach(key => {
      botIntelligence.consecutiveActions[key] = 0;
    });
    
    return {
      action: 'GOTO',
      args: {
        x: Math.round(targetX),
        y: currentPos.y,
        z: Math.round(targetZ),
        radius: 3
      },
      horizon_ms: 1200
    };
  }
  
  return null;
}

// Update positional tracking for stuck detection
function updatePositionTracking(botInstance) {
  const currentPos = botInstance.entity.position.clone();
  botIntelligence.lastPositions.push({
    position: currentPos,
    timestamp: Date.now()
  });
  
  // Keep only recent positions
  if (botIntelligence.lastPositions.length > 10) {
    botIntelligence.lastPositions.shift();
  }
}

// Check if bot should use context-aware decision making
function shouldUseContextAwareDecision(botInstance) {
  if (!CONFIG.intelligence.contextAwareness) return false;
  
  // Check if we're near trees and last action was movement
  const lastAction = botIntelligence.actionMemory[botIntelligence.actionMemory.length - 1];
  if (lastAction && lastAction.action.type === 'GOTO') {
    const currentPos = botInstance.entity.position;
    const nearbyTrees = findNearbyTrees(botInstance, CONFIG.intelligence.proximityMiningDistance);
    
    if (nearbyTrees.length > 0) {
      console.log(`[INTELLIGENCE] 🎯 Context-aware: Near trees after movement - suggesting mining action`);
      return true;
    }
  }
  
  return false;
}

// Find nearby trees for context awareness
function findNearbyTrees(botInstance, radius) {
  const currentPos = botInstance.entity.position;
  const trees = [];
  
  for (let x = -radius; x <= radius; x++) {
    for (let y = -2; y <= 2; y++) {
      for (let z = -radius; z <= radius; z++) {
        const blockPos = currentPos.clone().offset(x, y, z);
        const block = botInstance.blockAt(blockPos);
        if (block && isTreeBlock(block)) {
          trees.push(block);
        }
      }
    }
  }
  
  return trees;
}

// Build behavioral intelligence context for LLM prompt
function buildIntelligenceContext(observation) {
  if (!CONFIG.intelligence.behavioralOverrides) {
    return '🤖 Behavioral Intelligence: DISABLED';
  }
  
  const recentActions = botIntelligence.actionMemory.slice(-5);
  const actionPattern = recentActions.map(a => a.action.type || a.action.action).join(' → ');
  
  const stuckStatus = botIntelligence.behaviorFlags.isStuck ? '⚠️ STUCK BEHAVIOR DETECTED' : '✅ Normal behavior';
  const consecutiveCount = Math.max(...Object.values(botIntelligence.consecutiveActions));
  
  let suggestions = '';
  
  // Intelligent mining suggestions
  const nearbyTrees = findNearbyTrees(bot, 3);
  if (nearbyTrees.length > 0 && botIntelligence.lastLLMDecision?.action === 'GOTO') {
    suggestions += `\n🎯 INTELLIGENT SUGGESTION: You are near ${nearbyTrees.length} tree(s). Consider using MINE_TREE instead of more GOTO commands.`;
  }
  
  // Exploration suggestion
  if (consecutiveCount >= 3 && botIntelligence.lastLLMDecision?.action === 'GOTO') {
    suggestions += `\n🔍 EXPLORATION NEEDED: You've repeated GOTO ${consecutiveCount} times. Try exploring a different direction at least 20+ blocks away.`;
  }
  
  // Context awareness
  if (observation.nearby_trees?.length > 0 && !botIntelligence.lastLLMDecision?.action?.includes('MINE')) {
    suggestions += `\n⚡ CONTEXT ALERT: Trees detected but you haven't tried mining yet. Consider MINE_TREE action.`;
  }
  
  return `🤖 Behavioral Intelligence: ACTIVE
Pattern: ${actionPattern || 'No recent actions'}
Status: ${stuckStatus} (consecutive: ${consecutiveCount})
Last Override: ${botIntelligence.contextState.lastOverrideTime > 0 ? 
  `${((Date.now() - botIntelligence.contextState.lastOverrideTime) / 1000).toFixed(1)}s ago` : 'Never'}${suggestions}`;
}

// Build goal system status for LLM prompt
function buildGoalSystemStatus() {
  if (!goalSystem) return '🎯 Goal System: Not initialized';
  
  const status = goalSystem.getStatus();
  const activeGoalsList = status.activeGoals.length > 0 ? 
    status.activeGoals.map(g => `${g.name}(${g.priority})`).join(', ') : 'None';
  
  const threats = status.sensorData.nearbyMobs.filter(m => m.isHostile);
  const resources = status.sensorData.nearbyBlocks;
  
  let strategicNote = '';
  if (bot._llmValidator?.strategicRecommendations?.length > 0) {
    strategicNote = `\n💡 Strategic Advice: ${bot._llmValidator.strategicRecommendations.slice(0, 2).join(', ')}`;
  }
  
  return `🎯 Goal System: ACTIVE (${status.goalCount} goals loaded)
Active Goals: ${activeGoalsList}
Nearby Threats: ${threats.length > 0 ? threats.map(t => `${t.type}(${t.distance.toFixed(1)}m)`).join(', ') : 'None'}
Resources: ${resources.trees.length} trees, ${resources.ores.length} ores detected
Inventory: ${status.sensorData.inventory.wood} wood, ${status.sensorData.inventory.stone} stone, ${status.sensorData.inventory.tools} tools${strategicNote}`;
}

// ===== LLM-ENHANCED GOAL SYSTEM =====

class LLMGoalValidator {
  constructor(bot, goalSystem) {
    this.bot = bot;
    this.goalSystem = goalSystem;
    this.lastValidationTime = 0;
    this.strategicRecommendations = [];
  }

  async validateAndEnhanceGoals() {
    const now = Date.now();
    if (now - this.lastValidationTime < CONFIG.goalSystem.llmValidationInterval) return;
    this.lastValidationTime = now;

    try {
      const gameState = this.buildGameStateForLLM();
      const llmResponse = await this.consultLLM(gameState);
      this.applyLLMRecommendations(llmResponse);
    } catch (error) {
      console.log(`[LLM-GOAL] Validation error: ${error.message}`);
    }
  }

  buildGameStateForLLM() {
    const status = this.goalSystem.getStatus();
    return {
      position: this.bot.entity.position,
      health: this.bot.health,
      hunger: this.bot.food,
      timeOfDay: this.bot.time.timeOfDay,
      weather: this.bot.isRaining ? 'raining' : 'clear',
      inventory: status.sensorData.inventory,
      nearbyThreats: status.sensorData.nearbyMobs.filter(m => m.isHostile),
      nearbyResources: {
        trees: status.sensorData.nearbyBlocks.trees.slice(0, 3),
        ores: status.sensorData.nearbyBlocks.ores.slice(0, 3)
      },
      activeGoals: status.activeGoals,
      currentObjective: CONFIG.defaultGoal
    };
  }

  async consultLLM(gameState) {
    const prompt = this.buildLLMPrompt(gameState);
    
    const llmReq = {
      model: CONFIG.llm.model,
      messages: [
        { role: "system", content: "You are a strategic AI advisor for a Minecraft bot. Analyze the game state and provide tactical recommendations for goal priorities and actions. Respond in JSON format." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3, // Lower temperature for more strategic thinking
      max_tokens: 500
    };

    const resp = await fetch(CONFIG.llm.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(llmReq)
    });

    if (!resp.ok) throw new Error(`LLM HTTP error ${resp.status}`);
    
    const data = await resp.json();
    const responseText = data?.choices?.[0]?.message?.content?.trim() || '';
    
    try {
      return JSON.parse(responseText.replace(/```json\s*/g, '').replace(/```\s*/g, ''));
    } catch (e) {
      console.log(`[LLM-GOAL] Failed to parse LLM response: ${responseText}`);
      return { recommendations: [] };
    }
  }

  buildLLMPrompt(gameState) {
    return `MINECRAFT BOT STRATEGIC ANALYSIS

Current Game State:
- Position: (${gameState.position.x.toFixed(1)}, ${gameState.position.y}, ${gameState.position.z.toFixed(1)})
- Health: ${gameState.health}/20, Hunger: ${gameState.hunger}/20
- Time: ${this.getTimeDescription(gameState.timeOfDay)}, Weather: ${gameState.weather}
- Inventory: ${gameState.inventory.wood} wood, ${gameState.inventory.stone} stone, ${gameState.inventory.food} food, ${gameState.inventory.tools} tools

Active Goals: ${gameState.activeGoals.map(g => `${g.name}(${g.priority})`).join(', ') || 'None'}

Nearby Threats: ${gameState.nearbyThreats.length > 0 ? 
  gameState.nearbyThreats.map(t => `${t.type} at ${t.distance.toFixed(1)}m`).join(', ') : 'None'}

Nearby Resources: 
- Trees: ${gameState.nearbyResources.trees.length > 0 ? 
  gameState.nearbyResources.trees.map(t => `${t.type} at ${t.distance.toFixed(1)}m`).join(', ') : 'None'}
- Ores: ${gameState.nearbyResources.ores.length > 0 ? 
  gameState.nearbyResources.ores.map(o => `${o.type} at ${o.distance.toFixed(1)}m`).join(', ') : 'None'}

PRIMARY OBJECTIVE: ${gameState.currentObjective}

ANALYZE and provide strategic recommendations:

{
  "threat_level": "low|medium|high",
  "immediate_priority": "survival|resource_gathering|building|exploration",
  "goal_recommendations": [
    {
      "goal_name": "MineTreeGoal|SurvivalGoal|BuildShelterGoal|ExploreGoal",
      "priority_adjustment": -2 to +3,
      "reasoning": "why this goal should be prioritized or deprioritized"
    }
  ],
  "strategic_actions": [
    "specific action recommendations like 'gather wood before nightfall' or 'build shelter near water'"
  ],
  "resource_priorities": {
    "wood": 1-5,
    "stone": 1-5, 
    "food": 1-5
  }
}`;
  }

  getTimeDescription(timeOfDay) {
    if (timeOfDay < 6000) return 'Morning';
    if (timeOfDay < 12000) return 'Day';
    if (timeOfDay < 18000) return 'Evening';
    return 'Night';
  }

  applyLLMRecommendations(llmResponse) {
    if (!llmResponse.goal_recommendations) return;

    console.log(`[LLM-GOAL] 🧠 Strategic analysis complete. Threat level: ${llmResponse.threat_level || 'unknown'}`);
    console.log(`[LLM-GOAL] 🎯 Immediate priority: ${llmResponse.immediate_priority || 'continue current'}`);

    // Apply priority adjustments
    llmResponse.goal_recommendations.forEach(rec => {
      const goal = this.goalSystem.goals.find(g => g.name === rec.goal_name);
      if (goal && rec.priority_adjustment) {
        const oldPriority = goal.priority;
        goal.priority = Math.max(1, Math.min(10, goal.priority + rec.priority_adjustment));
        console.log(`[LLM-GOAL] ⚡ ${rec.goal_name}: ${oldPriority} → ${goal.priority} (${rec.reasoning})`);
      }
    });

    // Store strategic actions for future reference
    if (llmResponse.strategic_actions) {
      this.strategicRecommendations = llmResponse.strategic_actions;
      console.log(`[LLM-GOAL] 📋 Strategic actions: ${this.strategicRecommendations.join(', ')}`);
    }

    // Re-sort goals by new priorities
    this.goalSystem.goals.sort((a, b) => b.getDynamicPriority() - a.getDynamicPriority());
  }
}

// Initialize goal system when bot connects
async function initializeGoalSystem(botInstance) {
  if (!CONFIG.goalSystem.enabled) return;

  console.log('[GOAL-SYSTEM] 🤖 Initializing mob-like AI brain...');
  
  goalSystem = new GoalSelector(botInstance);
  
  // Add all goal types
  goalSystem.addGoal(new SurvivalGoal(botInstance));
  goalSystem.addGoal(new MineTreeGoal(botInstance));
  goalSystem.addGoal(new BuildShelterGoal(botInstance));
  goalSystem.addGoal(new ExploreGoal(botInstance));
  
  // Initialize LLM validator
  const llmValidator = new LLMGoalValidator(botInstance, goalSystem);
  
  // Start goal system tick loop
  const goalTicker = setInterval(() => {
    if (botInstance.entity && botInstance.entity.position) {
      goalSystem.tick();
      llmValidator.validateAndEnhanceGoals();
    }
  }, CONFIG.goalSystem.tickInterval);
  
  // Store references for cleanup
  botInstance._goalSystem = goalSystem;
  botInstance._goalTicker = goalTicker;
  botInstance._llmValidator = llmValidator;
  
  console.log('[GOAL-SYSTEM] ✅ AI brain online with', goalSystem.goals.length, 'goals loaded');
}

// Cleanup goal system
function cleanupGoalSystem(botInstance) {
  if (botInstance._goalTicker) {
    clearInterval(botInstance._goalTicker);
  }
  if (botInstance._goalSystem) {
    botInstance._goalSystem.activeGoals.forEach(goal => goal.stop());
  }
  console.log('[GOAL-SYSTEM] 🛑 AI brain shutdown');
}

// ===== SPECIFIC GOAL IMPLEMENTATIONS =====

class MineTreeGoal extends Goal {
  constructor(bot) {
    super(bot, 3, 'MineTreeGoal');
    this.targetTree = null;
    this.pathStarted = false;
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  canUse() {
    const trees = goalSystem.sensorData.nearbyBlocks.trees;
    if (trees.length === 0) return false;
    
    // Don't restart immediately after failures
    const timeSinceFailure = Date.now() - this.lastFailureTime;
    if (this.failureCount >= 3 && timeSinceFailure < 30000) { // 30 second cooldown
      return false;
    }
    
    // Prioritize if we need wood
    const inventory = goalSystem.sensorData.inventory;
    return inventory.wood < 10; // Need wood
  }

  canContinue() {
    return this.isActive && this.targetTree && 
           this.bot.blockAt(this.targetTree.position) && 
           this.isTreeBlock(this.bot.blockAt(this.targetTree.position));
  }

  start() {
    super.start();
    const trees = goalSystem.sensorData.nearbyBlocks.trees;
    this.targetTree = trees[0]; // Closest tree
    this.pathStarted = false;
  }

  stop() {
    super.stop();
    // Clear pathfinding goal when stopping
    if (this.bot.pathfinder) {
      this.bot.pathfinder.setGoal(null);
    }
  }

  async tick() {
    super.tick();
    if (!this.targetTree) return;

    const distance = this.bot.entity.position.distanceTo(this.targetTree.position);
    
    if (distance <= 4) { // Increased range slightly
      // Close enough to mine
      try {
        await this.mineTree();
        this.failureCount = 0; // Reset on success
        this.stop(); // Goal completed
      } catch (error) {
        console.log(`[MineTreeGoal] Mining failed: ${error.message}`);
        this.failureCount++;
        this.lastFailureTime = Date.now();
        this.stop();
      }
    } else if (!this.pathStarted) {
      // Start pathfinding to tree
      this.pathToTree();
    }
  }

  pathToTree() {
    if (!this.bot.pathfinder) return;
    try {
      const { goals } = require('mineflayer-pathfinder');
      const goal = new goals.GoalNear(this.targetTree.position.x, this.targetTree.position.y, this.targetTree.position.z, 2);
      this.bot.pathfinder.setGoal(goal);
      this.pathStarted = true;
    } catch (error) {
      console.log(`[MineTreeGoal] Pathfinding failed: ${error.message}`);
    }
  }

  async mineTree() {
    const startBlock = this.bot.blockAt(this.targetTree.position);
    if (!startBlock || !this.isTreeBlock(startBlock)) return;

    // Find all connected tree blocks
    const treeBlocks = this.findConnectedTreeBlocks(this.targetTree.position);
    console.log(`[MineTreeGoal] Found ${treeBlocks.length} tree blocks to mine`);

    let minedCount = 0;
    let failedCount = 0;
    
    // First try blocks that are already in range
    const closeBlocks = treeBlocks.filter(pos => {
      const dist = this.bot.entity.position.distanceTo(pos);
      return dist <= 4.5;
    });
    
    // Then add blocks that require pathfinding
    const farBlocks = treeBlocks.filter(pos => {
      const dist = this.bot.entity.position.distanceTo(pos);
      return dist > 4.5;
    });
    
    const blocksToMine = [...closeBlocks, ...farBlocks];
    console.log(`[MineTreeGoal] Found ${closeBlocks.length} close blocks, ${farBlocks.length} far blocks`);
    
    for (const blockPos of blocksToMine) {
      try {
        const block = this.bot.blockAt(blockPos);
        if (!block || !this.isTreeBlock(block)) continue;
        
        if (!this.bot.canDigBlock(block)) {
          console.log(`[MineTreeGoal] Cannot dig block at ${blockPos.x},${blockPos.y},${blockPos.z}`);
          continue;
        }

        // BEFORE trying to dig a block:
        const dist = this.bot.entity.position.distanceTo(block.position);
        if (dist > 5.0) {
          console.log(`[MineTreeGoal] Approaching block (was ${dist.toFixed(1)} away)`);
          try { 
            await approachBlock(this.bot, block.position, 8000);
          } catch (e) { 
            console.log('[MineTreeGoal] Path fail, trying closer blocks:', e.message); 
            continue;
          }
        }

        // Recompute block ref after walking (it may change/unload)
        const fresh = this.bot.blockAt(block.position);
        if (!fresh || !this.isTreeBlock(fresh)) continue;

        // Final distance check after approaching
        const finalDist = this.bot.entity.position.distanceTo(fresh.position);
        if (finalDist > 4.5) {
          console.log(`[MineTreeGoal] Still too far (${finalDist.toFixed(1)}), skipping this block`);
          continue;
        }

        // Face the block and freeze before digging
        await this.bot.lookAt(new Vec3(fresh.position.x + 0.5, fresh.position.y + 0.5, fresh.position.z + 0.5), true);
        await settleBeforeDig(this.bot);

        // optional: equip non-enchanted axe first to avoid weird NBT edge cases
        const axe = this.bot.inventory.items().find(i => /axe/i.test(i.name));
        if (axe) { 
          try { 
            await this.bot.equip(axe, 'hand');
          } catch {} 
        }

        // Dig with robust handling
        try {
          await safeDig(this.bot, fresh, 9000);
          minedCount++;
          console.log(`[MineTreeGoal] Dug ${fresh.name} (${minedCount}/${treeBlocks.length})`);
        } catch (e) {
          if (/enchants/i.test(String(e.message))) {
            // soft-skip: your prismarine-item patch should make this rare now
            continue;
          }
          console.log(`[MineTreeGoal] Error mining block: ${e.message}`);
          failedCount++;
          if (failedCount >= 5) { 
            console.log(`[MineTreeGoal] Too many failures (${failedCount})`); 
            break;
          }
        }
        
      } catch (error) {
        console.log(`[MineTreeGoal] Error mining block: ${error.message}`);
        if (/enchants/i.test(String(error && error.message))) {
          // soft-fail and continue to next block without incrementing the hard-failure counter
          continue
        }
        failedCount++;
        if (failedCount >= 5) {
          console.log(`[MineTreeGoal] Too many failures (${failedCount}), stopping tree mining`);
          break;
        }
      }
    }
    
    console.log(`[MineTreeGoal] Mining complete: ${minedCount} mined, ${failedCount} failed`);
  }

  isTreeBlock(block) { return block && (block.name.includes('log') || block.name.includes('wood')); }

  findConnectedTreeBlocks(startPos, visited = new Set(), maxBlocks = 50) {
    const key = `${startPos.x},${startPos.y},${startPos.z}`;
    if (visited.has(key) || visited.size >= maxBlocks) return [];
    
    const block = this.bot.blockAt(startPos);
    if (!block || !this.isTreeBlock(block)) return [];
    
    visited.add(key);
    const blocks = [startPos.clone()];
    
    // Check 6 adjacent positions
    const offsets = [[0,1,0], [0,-1,0], [1,0,0], [-1,0,0], [0,0,1], [0,0,-1]];
    for (const [dx, dy, dz] of offsets) {
      const newPos = startPos.clone().offset(dx, dy, dz);
      blocks.push(...this.findConnectedTreeBlocks(newPos, visited, maxBlocks));
    }
    
    return blocks;
  }

  getDynamicPriority() {
    const inventory = goalSystem.sensorData.inventory;
    const trees = goalSystem.sensorData.nearbyBlocks.trees;
    
    // Higher priority if we really need wood and trees are close
    if (inventory.wood === 0 && trees.length > 0) return 5;
    if (inventory.wood < 5 && trees.length > 0) return 4;
    return this.priority;
  }
}

class SurvivalGoal extends Goal {
  constructor(bot) {
    super(bot, 10, 'SurvivalGoal'); // Highest priority
  }

  canUse() {
    const health = goalSystem.sensorData.health;
    const hunger = goalSystem.sensorData.hunger;
    const hostileMobs = goalSystem.sensorData.nearbyMobs.filter(m => m.isHostile);
    
    return health < 10 || hunger < 6 || hostileMobs.length > 0;
  }

  canContinue() {
    return this.canUse(); // Keep running while in danger
  }

  tick() {
    super.tick();
    const health = goalSystem.sensorData.health;
    const hunger = goalSystem.sensorData.hunger;
    const hostileMobs = goalSystem.sensorData.nearbyMobs.filter(m => m.isHostile && m.distance < 8);

    if (hostileMobs.length > 0) {
      this.handleCombat(hostileMobs);
    } else if (hunger < 6) {
      this.handleHunger();
    } else if (health < 10) {
      this.handleHealing();
    }
  }

  handleCombat(hostileMobs) {
    const nearest = hostileMobs[0];
    console.log(`[SurvivalGoal] Hostile ${nearest.type} nearby! Distance: ${nearest.distance.toFixed(1)}`);
    
    // Simple combat: look at mob and attack if close
    if (nearest.distance < 3) {
      this.bot.lookAt(nearest.position);
      this.bot.attack(this.bot.nearestEntity(entity => entity.name === nearest.type));
    } else {
      // Run away or get a weapon
      this.fleeFromDanger();
    }
  }

  handleHunger() {
    const food = this.bot.inventory.items().find(item => 
      item.name.includes('bread') || item.name.includes('meat') || item.name.includes('apple')
    );
    
    if (food) {
      console.log(`[SurvivalGoal] Eating ${food.name}`);
      this.bot.equip(food, 'hand').then(() => this.bot.consume());
    }
  }

  handleHealing() {
    // Find safe spot and wait for regeneration
    console.log(`[SurvivalGoal] Low health (${goalSystem.sensorData.health}), seeking safety`);
  }

  fleeFromDanger() {
    // Simple flee logic - move away from danger
    const hostiles = goalSystem.sensorData.nearbyMobs.filter(m => m.isHostile);
    if (hostiles.length === 0) return;
    
    const avgThreatPos = hostiles.reduce(
      (acc, mob) => acc.add(mob.position), 
      new (require('vec3'))(0, 0, 0)
    ).scale(1 / hostiles.length);
    
    const fleeDirection = this.bot.entity.position.minus(avgThreatPos).normalize();
    const fleeTarget = this.bot.entity.position.plus(fleeDirection.scale(10));
    
    if (this.bot.pathfinder) {
      const { goals } = require('mineflayer-pathfinder');
      const goal = new goals.GoalNear(fleeTarget.x, fleeTarget.y, fleeTarget.z, 1);
      this.bot.pathfinder.setGoal(goal);
    }
  }
}

class ExploreGoal extends Goal {
  constructor(bot) {
    super(bot, 1, 'ExploreGoal'); // Lowest priority
    this.targetPosition = null;
    this.isMoving = false;
  }

  canUse() {
    // Explore if no immediate objectives and not much inventory
    const inventory = goalSystem.sensorData.inventory;
    const trees = goalSystem.sensorData.nearbyBlocks.trees;
    const ores = goalSystem.sensorData.nearbyBlocks.ores;
    
    return trees.length === 0 && ores.length === 0 && inventory.total < 20;
  }

  start() {
    super.start();
    this.generateExploreTarget();
  }

  tick() {
    super.tick();
    if (!this.isMoving && this.targetPosition) {
      this.moveToTarget();
    }
    
    // Check if we've reached target or found something interesting
    if (this.targetPosition && this.bot.entity.position.distanceTo(this.targetPosition) < 3) {
      console.log(`[ExploreGoal] Reached exploration target, stopping`);
      this.stop();
    }
  }

  generateExploreTarget() {
    const currentPos = this.bot.entity.position;
    const angle = Math.random() * 2 * Math.PI;
    const distance = 20 + Math.random() * 30; // 20-50 blocks away
    
    this.targetPosition = currentPos.clone().offset(
      Math.cos(angle) * distance,
      0,
      Math.sin(angle) * distance
    );
    
    console.log(`[ExploreGoal] Generated explore target: ${this.targetPosition.x.toFixed(1)}, ${this.targetPosition.z.toFixed(1)}`);
  }

  moveToTarget() {
    if (!this.bot.pathfinder || !this.targetPosition) return;
    
    try {
      const { goals } = require('mineflayer-pathfinder');
      const goal = new goals.GoalNear(this.targetPosition.x, this.targetPosition.y, this.targetPosition.z, 3);
      this.bot.pathfinder.setGoal(goal);
      this.isMoving = true;
    } catch (error) {
      console.log(`[ExploreGoal] Pathfinding failed: ${error.message}`);
    }
  }
}

// Build intelligent shelter goal
class BuildShelterGoal extends Goal {
  constructor(bot) {
    super(bot, 2, 'BuildShelterGoal');
    this.shelterLocation = null;
    this.buildingPhase = 'planning'; // planning, foundation, walls, roof, complete
  }

  canUse() {
    const timeOfDay = this.bot.time.timeOfDay;
    const isNight = timeOfDay > 13000 && timeOfDay < 23000;
    const inventory = goalSystem.sensorData.inventory;
    const hostileMobs = goalSystem.sensorData.nearbyMobs.filter(m => m.isHostile);
    
    return (isNight || hostileMobs.length > 0) && inventory.wood >= 10 && inventory.stone >= 5;
  }

  start() {
    super.start();
    this.findShelterLocation();
  }

  tick() {
    super.tick();
    switch (this.buildingPhase) {
      case 'planning':
        this.planShelter();
        break;
      case 'foundation':
        this.buildFoundation();
        break;
      case 'walls':
        this.buildWalls();
        break;
      case 'roof':
        this.buildRoof();
        break;
    }
  }

  findShelterLocation() {
    // Find flat area near current position
    const currentPos = this.bot.entity.position;
    this.shelterLocation = currentPos.clone().offset(5, 0, 5);
    console.log(`[BuildShelterGoal] Planning shelter at ${this.shelterLocation.x}, ${this.shelterLocation.z}`);
  }

  planShelter() {
    // Simple 3x3 shelter plan
    this.buildingPhase = 'foundation';
  }

  buildFoundation() {
    // Place blocks for foundation
    console.log(`[BuildShelterGoal] Building foundation...`);
    this.buildingPhase = 'walls';
  }

  buildWalls() {
    console.log(`[BuildShelterGoal] Building walls...`);
    this.buildingPhase = 'roof';
  }

  buildRoof() {
    console.log(`[BuildShelterGoal] Building roof...`);
    this.buildingPhase = 'complete';
    this.stop();
  }

  getDynamicPriority() {
    const timeOfDay = this.bot.time.timeOfDay;
    const isNight = timeOfDay > 13000 && timeOfDay < 23000;
    const hostileMobs = goalSystem.sensorData.nearbyMobs.filter(m => m.isHostile);
    
    if (isNight && hostileMobs.length > 0) return 8; // Very high priority
    if (isNight || hostileMobs.length > 0) return 5;
    return this.priority;
  }
}

// Get the best tool for mining a specific block
function getBestTool(botInstance, block) {
  const mcData = require('minecraft-data')(botInstance.version);
  const tools = [];
  
  // Get all tools from inventory
  botInstance.inventory.items().forEach(item => {
    if (item.name.includes('pickaxe') || 
        item.name.includes('axe') || 
        item.name.includes('shovel') || 
        item.name.includes('hoe') ||
        item.name.includes('sword')) {
      tools.push(item);
    }
  });
  
  if (tools.length === 0) {
    return null; // No tools available, use hand
  }
  
  // Determine best tool based on block type
  const blockName = block.name.toLowerCase();
  let preferredToolType = null;
  
  // Tree/wood blocks need axe
  if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('planks')) {
    preferredToolType = 'axe';
  }
  // Stone/ore blocks need pickaxe
  else if (blockName.includes('stone') || blockName.includes('ore') || 
           blockName.includes('cobblestone') || blockName.includes('obsidian')) {
    preferredToolType = 'pickaxe';
  }
  // Dirt/sand/gravel need shovel
  else if (blockName.includes('dirt') || blockName.includes('sand') || 
           blockName.includes('gravel') || blockName.includes('clay')) {
    preferredToolType = 'shovel';
  }
  
  // Find best tool of preferred type
  let bestTool = null;
  let bestToolTier = -1;
  
  // Tool tier ranking: wood < stone < iron < diamond < netherite
  const toolTiers = {
    'wooden': 0, 'wood': 0,
    'stone': 1,
    'iron': 2,
    'diamond': 3,
    'netherite': 4,
    'golden': 1.5 // Gold is fast but weak
  };
  
  tools.forEach(tool => {
    const toolName = tool.name.toLowerCase();
    
    // Check if this tool matches preferred type
    if (preferredToolType && toolName.includes(preferredToolType)) {
      // Get tool tier
      let tier = 0;
      Object.keys(toolTiers).forEach(material => {
        if (toolName.includes(material)) {
          tier = toolTiers[material];
        }
      });
      
      if (tier > bestToolTier) {
        bestTool = tool;
        bestToolTier = tier;
      }
    }
  });
  
  // If no preferred tool found, use best available tool
  if (!bestTool && tools.length > 0) {
    bestTool = tools.reduce((best, current) => {
      const currentName = current.name.toLowerCase();
      const bestName = best.name.toLowerCase();
      
      // Prefer pickaxes for general mining
      if (currentName.includes('pickaxe') && !bestName.includes('pickaxe')) {
        return current;
      }
      if (bestName.includes('pickaxe') && !currentName.includes('pickaxe')) {
        return best;
      }
      
      // Compare material tiers
      let currentTier = 0;
      let bestTier = 0;
      
      Object.keys(toolTiers).forEach(material => {
        if (currentName.includes(material)) currentTier = toolTiers[material];
        if (bestName.includes(material)) bestTier = toolTiers[material];
      });
      
      return currentTier > bestTier ? current : best;
    });
  }
  
  return bestTool;
}

// Safe fallback for dig time calculation when enchantment data fails
function getEstimatedDigTime(block, heldItem) {
  const blockHardness = {
    'oak_log': 2.0, 'birch_log': 2.0, 'spruce_log': 2.0, 'jungle_log': 2.0, 
    'acacia_log': 2.0, 'dark_oak_log': 2.0, 'mangrove_log': 2.0, 'cherry_log': 2.0,
    'stone': 1.5, 'cobblestone': 2.0, 'dirt': 0.5, 'grass_block': 0.6,
    'sand': 0.5, 'gravel': 0.6, 'coal_ore': 3.0, 'iron_ore': 3.0
  };
  
  const baseTime = blockHardness[block.name] || 1.0; // Default 1 second for unknown blocks
  
  // Tool efficiency multipliers
  const toolMultipliers = {
    'wooden': 2.0, 'stone': 4.0, 'iron': 6.0, 'diamond': 8.0, 'netherite': 9.0, 'golden': 12.0
  };
  
  let multiplier = 1.0; // Hand mining is slow
  
  if (heldItem) {
    const toolName = heldItem.name.toLowerCase();
    Object.keys(toolMultipliers).forEach(material => {
      if (toolName.includes(material)) {
        multiplier = toolMultipliers[material];
      }
    });
  }
  
  // Calculate time in milliseconds (base time / multiplier * 1000)
  return Math.max((baseTime / multiplier) * 1000, 250); // Minimum 250ms
}

// Check if a block is part of a tree (log or wood)
function isTreeBlock(block) {
  if (!block) return false;
  const name = block.name.toLowerCase();
  return name.includes('log') || name.includes('wood') || name.endsWith('_log');
}

// Find all connected tree blocks using flood-fill algorithm
function findConnectedTreeBlocks(botInstance, startPos, maxBlocks = 200) {
  const visited = new Set();
  const treeBlocks = [];
  const queue = [startPos];
  
  while (queue.length > 0 && treeBlocks.length < maxBlocks) {
    const currentPos = queue.shift();
    const key = `${currentPos.x},${currentPos.y},${currentPos.z}`;
    
    if (visited.has(key)) continue;
    visited.add(key);
    
    const block = botInstance.blockAt(currentPos);
    if (!block || !isTreeBlock(block)) continue;
    
    treeBlocks.push(currentPos.clone());
    
    // Check all 26 adjacent positions (3x3x3 cube minus center)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue; // Skip center
          
          const neighborPos = currentPos.offset(dx, dy, dz);
          const neighborKey = `${neighborPos.x},${neighborPos.y},${neighborPos.z}`;
          
          if (!visited.has(neighborKey)) {
            queue.push(neighborPos);
          }
        }
      }
    }
  }
  
  return treeBlocks;
}

// ===== FILE LOGGING SYSTEM =====
class BotLogger {
  constructor(config) {
    this.config = config;
    this.logFile = config.logging.logFile;
    this.actionCount = 0;
    
    // Create log files if they don't exist
    if (config.logging.toFile) {
      this.ensureLogFile();
      this.ensureSeparateLogFiles();
    }
  }

  ensureLogFile() {
    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, `=== Bot Session Started: ${new Date().toISOString()} ===\n`);
    }
  }

  ensureSeparateLogFiles() {
    const separateFiles = this.config.logging.separateFiles;
    Object.values(separateFiles).forEach(filePath => {
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, `=== Log Started: ${new Date().toISOString()} ===\n`);
      }
    });
  }

  writeToSeparateFile(type, content) {
    const separateFiles = this.config.logging.separateFiles;
    const filePath = separateFiles[type];
    
    if (filePath && this.config.logging.toFile) {
      try {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${content}\n${'='.repeat(80)}\n`;
        fs.appendFileSync(filePath, logLine);
      } catch (e) {
        console.error(`Error writing to ${type} log:`, e);
      }
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

// Debug LM Studio connection
console.log('[DEBUG] LM Studio URL:', CONFIG.llm.url);
console.log('[DEBUG] LM Studio Model:', CONFIG.llm.model);

// IMPORTANT: Patch prismarine-item BEFORE createBot to ensure the correct prototypes are patched
patchPrismarineItemVariants(['auto', CONFIG.version]);

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

  // Initialize goal-based AI system
  initializeGoalSystem(bot);

  // Start auto mode if enabled
  if (CONFIG.autoMode.enabled) {
    logger.logSystem('Starting auto mode with LM Studio');
    startAutoMode();
  }
});

bot.on('end', () => {
  console.log('[bot] connection ended');
  logger.logBot('connection_ended');
  stopAutoMode();
  cleanupGoalSystem(bot);
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
  
  // Comprehensive block mapping for better LLM understanding
  const blockMap = {
    // Air and space
    'air': ' ',
    
    // Natural terrain
    'grass_block': 'G',
    'dirt': 'D',
    'stone': 'S',
    'cobblestone': 'C',
    'sand': 's',
    'gravel': 'g',
    'clay': 'c',
    'snow': 'n',
    'snow_block': 'N',
    'podzol': 'P',
    'coarse_dirt': 'd',
    
    // Water and liquids
    'water': '~',
    'flowing_water': '~',
    'lava': '!',
    'flowing_lava': '!',
    'ice': 'I',
    'packed_ice': 'i',
    'blue_ice': 'b',
    
    // ALL TREE TYPES - Critical for tree detection
    'oak_log': 'T',
    'birch_log': 'T', 
    'spruce_log': 'T',
    'jungle_log': 'T',
    'acacia_log': 'T',
    'dark_oak_log': 'T',
    'cherry_log': 'T',
    'mangrove_log': 'T',
    'stripped_oak_log': 'T',
    'stripped_birch_log': 'T',
    'stripped_spruce_log': 'T',
    'stripped_jungle_log': 'T',
    'stripped_acacia_log': 'T',
    'stripped_dark_oak_log': 'T',
    'oak_wood': 'T',
    'birch_wood': 'T',
    'spruce_wood': 'T',
    'jungle_wood': 'T',
    'acacia_wood': 'T',
    'dark_oak_wood': 'T',
    
    // Leaves (L for leaves nearby trees)
    'oak_leaves': 'L',
    'birch_leaves': 'L',
    'spruce_leaves': 'L',
    'jungle_leaves': 'L',
    'acacia_leaves': 'L',
    'dark_oak_leaves': 'L',
    'cherry_leaves': 'L',
    'mangrove_leaves': 'L',
    
    // Wood products
    'oak_planks': 'w',
    'birch_planks': 'w',
    'spruce_planks': 'w',
    'jungle_planks': 'w',
    'acacia_planks': 'w',
    'dark_oak_planks': 'w',
    
    // Ores and minerals
    'coal_ore': 'O',
    'iron_ore': 'O',
    'gold_ore': 'O',
    'diamond_ore': 'O',
    'emerald_ore': 'O',
    'redstone_ore': 'R',
    'lapis_ore': 'O',
    'copper_ore': 'O',
    'deepslate_coal_ore': 'O',
    'deepslate_iron_ore': 'O',
    'deepslate_gold_ore': 'O',
    'deepslate_diamond_ore': 'O',
    
    // Building blocks
    'brick': 'B',
    'glass': 'X',
    'wool': 'W',
    'concrete': 'K',
    'terracotta': 'Y',
    
    // Functional blocks
    'chest': 'H',
    'furnace': 'F',
    'crafting_table': 'A',
    'bed': 'E',
    'door': 'U',
    'torch': 't',
    'lantern': 'l',
    
    // Paths and roads
    'dirt_path': 'p',
    'grass_path': 'p',
    
    // Default for solid blocks
    'default_solid': '#'
  };
  
  // Direct mapping
  if (blockMap[block.name]) {
    return blockMap[block.name];
  }
  
  // Pattern matching for similar blocks - IMPROVED TREE DETECTION
  const name = block.name.toLowerCase();
  if (name.includes('log') || name.includes('wood') || name.endsWith('_log')) return 'T';
  if (name.includes('leaves')) return 'L';
  if (name.includes('plank')) return 'w';
  if (name.includes('ore')) return 'O';
  if (name.includes('stone')) return 'S';
  if (name.includes('wool')) return 'W';
  if (name.includes('glass')) return 'X';
  if (name.includes('door')) return 'U';
  if (name.includes('water')) return '~';
  if (name.includes('lava')) return '!';
  if (name.includes('sand')) return 's';
  if (name.includes('grass')) return 'G';
  if (name.includes('dirt')) return 'D';
  
  // Check if block is solid/walkable
  if (block.boundingBox === 'block') {
    return '#';
  }
  return '.';
}

function makeMiniMap(botInstance, radius = 16) {
  const e = botInstance.entity;
  if (!e?.position) return '(not ready)';
  
  const centerX = Math.floor(e.position.x);
  const centerY = Math.floor(e.position.y);
  const centerZ = Math.floor(e.position.z);
  
  // Create comprehensive multi-layer map
  const groundY = centerY - 1; // Ground level
  const currentY = centerY;     // Current level
  const aboveY = centerY + 1;   // Above level
  
  // Track important block coordinates
  const importantBlocks = {
    trees: [],
    ores: [],
    water: [],
    chests: [],
    boundaries: {
      north: centerZ + radius,
      south: centerZ - radius,
      east: centerX + radius,
      west: centerX - radius
    }
  };
  
  // Build the main map grid
  const lines = [];
  const coordinateMarkers = [];
  
  // Header with coordinate information
  const header = `=== CHUNK MAP: Bot at (${centerX}, ${centerY}, ${centerZ}) ===`;
  const bounds = `Viewing: X(${centerX-radius} to ${centerX+radius}) Z(${centerZ-radius} to ${centerZ+radius})`;
  
  for (let dz = radius; dz >= -radius; dz--) {
    let row = '';
    const currentZ = centerZ + dz;
    
    for (let dx = -radius; dx <= radius; dx++) {
      const currentX = centerX + dx;
      
      // Bot position marker
      if (dx === 0 && dz === 0) { 
        row += '@'; 
        continue; 
      }
      
      // Check ground level first, then current level
      let symbol = ' ';
      let blockFound = false;
      
      // Check multiple Y levels for better detection
      for (let yOffset = -1; yOffset <= 2; yOffset++) {
        const pos = new Vec3(currentX, centerY + yOffset, currentZ);
        const block = botInstance.blockAt(pos);
        
        if (block && block.name !== 'air') {
          symbol = blockSymbol(block);
          blockFound = true;
          
          // Track important blocks with coordinates
          if (symbol === 'T') {
            importantBlocks.trees.push({x: currentX, y: centerY + yOffset, z: currentZ});
          } else if (symbol === 'O') {
            importantBlocks.ores.push({x: currentX, y: centerY + yOffset, z: currentZ});
          } else if (symbol === '~') {
            importantBlocks.water.push({x: currentX, y: centerY + yOffset, z: currentZ});
          } else if (symbol === 'H') {
            importantBlocks.chests.push({x: currentX, y: centerY + yOffset, z: currentZ});
          }
          break; // Use the first solid block found
        }
      }
      
      if (!blockFound) {
        symbol = '.'; // Walkable space
      }
      
      row += symbol;
    }
    
    // Add coordinate markers every 8 blocks
    if (dz % 8 === 0 && dz !== 0) {
      coordinateMarkers.push(`Z=${currentZ} | ${row}`);
    } else {
      lines.push(row);
    }
  }
  
  // Overlay nearby entities as 'M' (Mobs/Entities)
  const ents = Object.values(botInstance.entities || {})
    .filter(en => en !== e && en.position)
    .filter(en => Math.abs(en.position.x - centerX) <= radius + 0.5 &&
                  Math.abs(en.position.z - centerZ) <= radius + 0.5);
  
  const grid = lines.map(s => s.split(''));
  ents.forEach(en => {
    const dx = Math.round(en.position.x - centerX);
    const dz = Math.round(en.position.z - centerZ);
    const gx = dx + radius;
    const gz = radius - dz;
    if (gz >= 0 && gz < grid.length && gx >= 0 && gx < grid[0].length) {
      grid[gz][gx] = 'M';
    }
  });
  
  // Generate coordinate reference for edges
  const topCoords = `     ${Array.from({length: Math.ceil((radius*2+1)/4)}, (_, i) => {
    const x = centerX - radius + (i * 4);
    return `${x}`.padStart(4, ' ');
  }).join('')}`;
  
  const bottomCoords = `     ${Array.from({length: Math.ceil((radius*2+1)/4)}, (_, i) => {
    const x = centerX - radius + (i * 4);
    return `${x}`.padStart(4, ' ');
  }).join('')}`;
  
  // Build final map with coordinates and important block summary
  const finalMap = [
    header,
    bounds,
    topCoords,
    ...grid.map((row, i) => {
      const z = centerZ + radius - i;
      return `${z.toString().padStart(4, ' ')} ${row.join('')}`;
    }),
    bottomCoords,
    '',
    '=== IMPORTANT BLOCKS DETECTED ===',
    importantBlocks.trees.length > 0 ? 
      `🌳 TREES (T): ${importantBlocks.trees.length} found at: ${importantBlocks.trees.slice(0,3).map(t => `(${t.x},${t.y},${t.z})`).join(', ')}${importantBlocks.trees.length > 3 ? '...' : ''}` :
      '🌳 TREES (T): None visible in current area',
    importantBlocks.ores.length > 0 ? 
      `⛏️ ORES (O): ${importantBlocks.ores.length} found at: ${importantBlocks.ores.slice(0,3).map(o => `(${o.x},${o.y},${o.z})`).join(', ')}${importantBlocks.ores.length > 3 ? '...' : ''}` :
      '⛏️ ORES (O): None visible',
    importantBlocks.water.length > 0 ? 
      `🌊 WATER (~): ${importantBlocks.water.length} blocks detected` :
      '🌊 WATER (~): None nearby',
    importantBlocks.chests.length > 0 ? 
      `📦 CHESTS (H): ${importantBlocks.chests.length} found at: ${importantBlocks.chests.map(c => `(${c.x},${c.y},${c.z})`).join(', ')}` :
      '📦 CHESTS (H): None visible',
    '',
    '=== LEGEND ===',
    '@ = You (bot)  |  T = Trees (logs/wood)  |  L = Leaves  |  O = Ores',
    'G = Grass  |  D = Dirt  |  S = Stone  |  ~ = Water  |  ! = Lava',
    'M = Mobs/Entities  |  H = Chests  |  . = Walkable  |  # = Solid',
    '',
    `=== NAVIGATION BOUNDARIES ===`,
    `North Edge (${importantBlocks.boundaries.north})  |  South Edge (${importantBlocks.boundaries.south})`,
    `East Edge (${importantBlocks.boundaries.east})   |  West Edge (${importantBlocks.boundaries.west})`
  ].join('\n');
  
  return finalMap;
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

  const minimap = makeMiniMap(bot, CONFIG.mapping.radius);
  
  // ENHANCED: Use mineflayer API to find trees in larger area
  const nearbyTrees = [];
  try {
    const treeBlocks = bot.findBlocks({
      matching: (block) => {
        const name = block?.name?.toLowerCase() || '';
        return name.includes('log') || name.includes('wood') || name.endsWith('_log');
      },
      maxDistance: CONFIG.mapping.radius + 8, // Search beyond map radius
      count: 20 // Find up to 20 trees
    });
    
    treeBlocks.forEach(pos => {
      const block = bot.blockAt(pos);
      if (block) {
        nearbyTrees.push({
          type: block.name,
          pos: { x: pos.x, y: pos.y, z: pos.z },
          distance: Math.sqrt(Math.pow(pos.x - e.position.x, 2) + Math.pow(pos.z - e.position.z, 2))
        });
      }
    });
    
    // Sort by distance
    nearbyTrees.sort((a, b) => a.distance - b.distance);
  } catch (error) {
    console.log('[trees] Tree search failed:', error.message);
  }
  
  // Use mineflayer API to find other important blocks
  const nearbyOres = [];
  try {
    const oreBlocks = bot.findBlocks({
      matching: (block) => {
        const name = block?.name?.toLowerCase() || '';
        return name.includes('ore');
      },
      maxDistance: CONFIG.mapping.radius,
      count: 10
    });
    
    oreBlocks.forEach(pos => {
      const block = bot.blockAt(pos);
      if (block) {
        nearbyOres.push({
          type: block.name,
          pos: { x: pos.x, y: pos.y, z: pos.z },
          distance: Math.sqrt(Math.pow(pos.x - e.position.x, 2) + Math.pow(pos.z - e.position.z, 2))
        });
      }
    });
  } catch (error) {
    console.log('[ores] Ore search failed:', error.message);
  }
  
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
    nearby_trees: nearbyTrees,  // NEW: Comprehensive tree detection
    nearby_ores: nearbyOres,    // NEW: Ore detection
    minimap_ascii: minimap,
    render_hint: buildRenderHint(bot),
    isInWater: CONFIG.movement.waterDetection ? isInWater(bot) : false
  };

  // Log detailed game state to separate file
  const gameStateDetails = {
    timestamp: new Date().toISOString(),
    position: obs.position,
    health: obs.health,
    hunger: obs.hunger,
    dimension: obs.dimension,
    timeOfDay: obs.timeOfDay,
    biome: obs.biome,
    isInWater: obs.isInWater,
    inventory: obs.inventory_summary,
    nearbyEntities: obs.nearby_entities,
    nearbyTrees: obs.nearby_trees,
    nearbyOres: obs.nearby_ores
  };
  
  logger.writeToSeparateFile('gameState', JSON.stringify(gameStateDetails, null, 2));
  
  // Log map to separate file
  const mapLogContent = [
    `Position: (${obs.position.x.toFixed(1)}, ${obs.position.y.toFixed(1)}, ${obs.position.z.toFixed(1)})`,
    `Health: ${obs.health}, Hunger: ${obs.hunger}, In Water: ${obs.isInWater}`,
    `Trees found: ${obs.nearby_trees.length}`,
    `Ores found: ${obs.nearby_ores.length}`,
    '',
    minimap
  ].join('\n');
  
  logger.writeToSeparateFile('maps', mapLogContent);

  if (LOG.stateSummary) {
    console.log(`[state] pos=(${obs.position.x.toFixed(1)},${obs.position.y.toFixed(1)},${obs.position.z.toFixed(1)}) hp=${obs.health} food=${obs.hunger} trees=${obs.nearby_trees.length}`);
  }
  return obs;
}

// ====== ACTIONS & VALIDATION ======
const ACTION_JSON_SCHEMA = {
  type: "object",
  required: ["action"],
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["MOVE","LOOK_AT","GOTO","MINE_AT","MINE_TREE","PLACE_AT","ATTACK_NEAREST","SELECT_HOTBAR","EAT","CRAFT"] },
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

  // Set current action and start time for tracking
  currentAction = { action, args, horizon_ms };
  actionStartTime = Date.now();

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
        
        const targetPos = new Vec3(x, y, z);
        const currentPos = bot.entity.position;
        
        // Check if already at target
        const distance = Math.sqrt(
          Math.pow(currentPos.x - x, 2) + 
          Math.pow(currentPos.y - y, 2) + 
          Math.pow(currentPos.z - z, 2)
        );
        
        if (distance <= radius + 0.5) {
          console.log(`[movement] Already at target (distance: ${distance.toFixed(2)})`);
          break;
        }

        console.log(`[movement] Moving to (${x}, ${y}, ${z}) from (${currentPos.x.toFixed(1)}, ${currentPos.y.toFixed(1)}, ${currentPos.z.toFixed(1)}) - distance: ${distance.toFixed(2)}`);
        
        // Clear any existing pathfinder goal first
        bot.pathfinder.setGoal(null);
        await new Promise(resolve => setTimeout(resolve, 50)); // Brief pause to clear previous goals
        
        // Check if target block is solid/unreachable
        const targetBlock = bot.blockAt(targetPos);
        let adjustedTarget = targetPos.clone();
        
        if (targetBlock && targetBlock.name !== 'air' && targetBlock.boundingBox === 'block') {
          console.log(`[movement] Target is inside solid block ${targetBlock.name}, adjusting position`);
          // Try to find air block above or nearby
          let foundAir = false;
          for (let checkY = y; checkY <= y + 3 && !foundAir; checkY++) {
            const checkBlock = bot.blockAt(new Vec3(x, checkY, z));
            if (!checkBlock || checkBlock.name === 'air') {
              adjustedTarget = new Vec3(x, checkY, z);
              foundAir = true;
              break;
            }
          }
          
          // If no air above, try nearby positions
          if (!foundAir) {
            const offsets = [
              {x: 1, z: 0}, {x: -1, z: 0}, {x: 0, z: 1}, {x: 0, z: -1},
              {x: 1, z: 1}, {x: -1, z: -1}, {x: 1, z: -1}, {x: -1, z: 1}
            ];
            
            for (const offset of offsets) {
              const nearbyPos = new Vec3(x + offset.x, y, z + offset.z);
              const nearbyBlock = bot.blockAt(nearbyPos);
              if (!nearbyBlock || nearbyBlock.name === 'air') {
                adjustedTarget = nearbyPos;
                foundAir = true;
                break;
              }
            }
          }
          
          if (foundAir) {
            console.log(`[movement] Adjusted target to (${adjustedTarget.x}, ${adjustedTarget.y}, ${adjustedTarget.z})`);
          }
        }

        // Check if bot is currently in water
        if (CONFIG.movement.waterDetection && isInWater(bot)) {
          logger.logAction({ action, args }, 'warning', 'Bot is in water, finding nearest land first');
          
          const landPos = findNearestLand(bot);
          if (landPos) {
            console.log(`[movement] Swimming to land at (${landPos.x}, ${landPos.y}, ${landPos.z})`);
            
            // First swim to land
            bot.pathfinder.setGoal(new GoalNear(landPos.x, landPos.y, landPos.z, 1));
            
            // Wait for land reaching with swimming timeout
            const swimTimeout = calculateMovementTime(currentPos, landPos, true);
            await new Promise((resolve, reject) => {
              const startTime = Date.now();
              const checkInterval = setInterval(() => {
                const pos = bot.entity.position;
                const distance = Math.sqrt(
                  Math.pow(pos.x - landPos.x, 2) + 
                  Math.pow(pos.y - landPos.y, 2) + 
                  Math.pow(pos.z - landPos.z, 2)
                );
                
                if (distance <= 2 || !isInWater(bot)) {
                  clearInterval(checkInterval);
                  console.log('[movement] Reached land, continuing to target');
                  resolve();
                } else if (Date.now() - startTime > swimTimeout) {
                  clearInterval(checkInterval);
                  bot.pathfinder.setGoal(null);
                  reject(new Error(`Swimming to land timeout after ${swimTimeout}ms`));
                }
              }, 200);
            });
          }
        }

        // Check if path to target requires swimming
        if (CONFIG.movement.waterDetection && pathRequiresSwimming(bot, bot.entity.position, adjustedTarget)) {
          logger.logAction({ action, args }, 'warning', 'Path requires swimming through water');
          
          // Calculate swimming time
          const swimTime = calculateMovementTime(bot.entity.position, adjustedTarget, true);
          console.log(`[movement] Swimming route detected, estimated time: ${(swimTime/1000).toFixed(1)}s`);
        }

        try {
          // Set pathfinding goal to final target
          bot.pathfinder.setGoal(new GoalNear(adjustedTarget.x, adjustedTarget.y, adjustedTarget.z, radius));
          
          // Calculate expected movement time with buffer
          const expectedTime = calculateMovementTime(bot.entity.position, adjustedTarget, isInWater(bot));
          const timeout = Math.max(expectedTime * 1.5, CONFIG.actionSync.movementTimeout); // 1.5x buffer for safety
          
          console.log(`[movement] Going to (${adjustedTarget.x}, ${adjustedTarget.y}, ${adjustedTarget.z}) - estimated time: ${(expectedTime/1000).toFixed(1)}s, timeout: ${(timeout/1000).toFixed(1)}s`);
          
          // Wait for movement to complete or timeout
          const startTime = Date.now();
          let lastDistance = distance;
          let stuckCounter = 0;
          let hasMovedRecently = true;
          
          await new Promise((resolve, reject) => {
            const checkInterval = setInterval(() => {
              const currentPos = bot.entity.position;
              const currentDistance = Math.sqrt(
                Math.pow(currentPos.x - adjustedTarget.x, 2) + 
                Math.pow(currentPos.y - adjustedTarget.y, 2) + 
                Math.pow(currentPos.z - adjustedTarget.z, 2)
              );
              
              // Check if reached destination
              if (currentDistance <= radius + 0.5) {
                clearInterval(checkInterval);
                bot.pathfinder.setGoal(null);
                const actualTime = Date.now() - startTime;
                console.log(`[movement] Reached destination in ${(actualTime/1000).toFixed(1)}s`);
                resolve();
                return;
              }
              
              // Check if bot is making progress
              if (Math.abs(currentDistance - lastDistance) < 0.1) {
                stuckCounter++;
                hasMovedRecently = false;
                
                // If stuck for more than 3 seconds, try to unstuck
                if (stuckCounter >= 30) { // 3 seconds at 100ms intervals
                  console.log(`[movement] Bot appears stuck at distance ${currentDistance.toFixed(2)}, trying to unstuck`);
                  
                  // Try jumping and brief movement
                  bot.setControlState('jump', true);
                  bot.setControlState('forward', true);
                  setTimeout(() => {
                    bot.setControlState('jump', false);
                    bot.setControlState('forward', false);
                  }, 200);
                  
                  stuckCounter = 0;
                  
                  // If still very close to start and stuck, might be unreachable
                  if (currentDistance > distance * 0.8 && Date.now() - startTime > 5000) {
                    clearInterval(checkInterval);
                    bot.pathfinder.setGoal(null);
                    reject(new Error(`Cannot reach target - path may be blocked`));
                    return;
                  }
                }
              } else {
                stuckCounter = 0;
                hasMovedRecently = true;
              }
              
              lastDistance = currentDistance;
              
              // Check timeout
              if (Date.now() - startTime > timeout) {
                clearInterval(checkInterval);
                bot.pathfinder.setGoal(null);
                reject(new Error(`GOTO timeout after ${timeout}ms`));
              }
            }, 100);
          });
        } catch (error) {
          bot.pathfinder.setGoal(null);
          throw error;
        }
        break;
      }
      case 'MINE_AT': {
        const { x, y, z } = args;
        if ([x,y,z].some(v => typeof v !== 'number')) throw new Error('MINE_AT requires x,y,z');
        
        const targetPos = new Vec3(x, y, z);
        const block = bot.blockAt(targetPos);
        if (!block || block.name === 'air') {
          throw new Error(`No block to mine at (${x}, ${y}, ${z}) - found: ${block ? block.name : 'null'}`);
        }
        
        console.log(`[mining] Attempting to mine ${block.name} at (${x}, ${y}, ${z})`);
        
        // Check if we can actually dig this block
        if (!bot.canDigBlock(block)) {
          throw new Error(`Cannot dig ${block.name} - block is not diggable or out of reach`);
        }
        
        // Simple approach: mine with whatever is currently equipped
        console.log(`[mining] Mining ${block.name} with ${bot.heldItem ? bot.heldItem.name : 'hand'}`);
        
        // Use fixed timeout to avoid enchantment errors
        const digTime = 8000; // Fixed 8 second timeout
        console.log(`[mining] Using fixed dig time: ${(digTime/1000).toFixed(1)}s`);
        
        // Make sure we're close enough to mine
        const distance = bot.entity.position.distanceTo(targetPos);
        if (distance > 5) {
          throw new Error(`Too far from block to mine (distance: ${distance.toFixed(1)})`);
        }
        
        // Look at the block before mining
        await bot.lookAt(targetPos, true);
        
        // Start mining with comprehensive error handling
        const timeout = Math.max(digTime * 3, CONFIG.actionSync.miningTimeout); // 3x dig time or config timeout
        const startTime = Date.now();
        
        console.log(`[mining] Starting to dig ${block.name}, timeout: ${(timeout/1000).toFixed(1)}s`);
        
        await new Promise((resolve, reject) => {
          let diggingCompleted = false;
          let timeoutId;
          
          // Set up completion handler
          const onDiggingCompleted = (targetBlock) => {
            if (targetBlock.position.equals(targetPos)) {
              diggingCompleted = true;
              bot.removeListener('diggingCompleted', onDiggingCompleted);
              bot.removeListener('diggingAborted', onDiggingAborted);
              if (timeoutId) clearTimeout(timeoutId);
              
              const actualTime = Date.now() - startTime;
              console.log(`[mining] Successfully mined ${block.name} in ${(actualTime/1000).toFixed(1)}s`);
              resolve();
            }
          };
          
          // Set up abort handler
          const onDiggingAborted = (targetBlock) => {
            if (targetBlock.position.equals(targetPos)) {
              bot.removeListener('diggingCompleted', onDiggingCompleted);
              bot.removeListener('diggingAborted', onDiggingAborted);
              if (timeoutId) clearTimeout(timeoutId);
              reject(new Error(`Mining aborted for ${block.name}`));
            }
          };
          
          // Set up timeout
          timeoutId = setTimeout(() => {
            if (!diggingCompleted) {
              bot.removeListener('diggingCompleted', onDiggingCompleted);
              bot.removeListener('diggingAborted', onDiggingAborted);
              bot.stopDigging();
              reject(new Error(`Mining timeout after ${timeout}ms`));
            }
          }, timeout);
          
          // Register event listeners
          bot.on('diggingCompleted', onDiggingCompleted);
          bot.on('diggingAborted', onDiggingAborted);
          
          // Start digging
          bot.dig(block, true) // forceLook = true for better reliability
            .then(() => {
              // Digging promise resolved, but wait for event confirmation
              console.log(`[mining] Dig promise resolved for ${block.name}`);
            })
            .catch((error) => {
              bot.removeListener('diggingCompleted', onDiggingCompleted);
              bot.removeListener('diggingAborted', onDiggingAborted);
              if (timeoutId) clearTimeout(timeoutId);
              reject(new Error(`Digging failed: ${error.message}`));
            });
        });
        
        break;
      }
      case 'MINE_TREE': {
        const { x, y, z } = args;
        if ([x,y,z].some(v => typeof v !== 'number')) throw new Error('MINE_TREE requires x,y,z');
        
        const startPos = new Vec3(x, y, z);
        const startBlock = bot.blockAt(startPos);
        
        if (!startBlock || !isTreeBlock(startBlock)) {
          throw new Error(`No tree block at (${x}, ${y}, ${z}) - found: ${startBlock ? startBlock.name : 'null'}`);
        }
        
        console.log(`[tree-mining] Starting to mine tree at (${x}, ${y}, ${z})`);
        
        // Get optimal tool for tree mining (axe)
        const bestTool = getBestTool(bot, startBlock);
        if (bestTool && bot.heldItem?.type !== bestTool.type) {
          console.log(`[tree-mining] Equipping ${bestTool.name} for tree mining`);
          try {
            await bot.equip(bestTool, 'hand');
          } catch (error) {
            console.log(`[tree-mining] Could not equip ${bestTool.name}, continuing with current tool`);
          }
        }
        
        // Find all connected tree blocks using flood-fill algorithm
        const treeBlocks = findConnectedTreeBlocks(bot, startPos);
        console.log(`[tree-mining] Found ${treeBlocks.length} tree blocks to mine`);
        
        // Sort blocks by height (bottom to top for proper tree cutting)
        treeBlocks.sort((a, b) => a.y - b.y);
        
        let minedCount = 0;
        const totalBlocks = treeBlocks.length;
        
        // Mine each block systematically
        for (const blockPos of treeBlocks) {
          try {
            const block = bot.blockAt(blockPos);
            if (!block || block.name === 'air') continue; // Block already mined or changed
            
            if (!isTreeBlock(block)) continue; // Not a tree block anymore
            
            // Check if we can reach this block
            const distance = bot.entity.position.distanceTo(blockPos);
            if (distance > 5) {
              console.log(`[tree-mining] Block at (${blockPos.x}, ${blockPos.y}, ${blockPos.z}) too far (${distance.toFixed(1)}), moving closer`);
              
              // Try to get closer
              const moveTarget = blockPos.offset(0, -1, 0); // Stand on ground level
              if (bot.blockAt(moveTarget) && bot.blockAt(moveTarget).name !== 'air') {
                // Find nearby position
                const offsets = [{x:1,z:0}, {x:-1,z:0}, {x:0,z:1}, {x:0,z:-1}];
                for (const offset of offsets) {
                  const testPos = new Vec3(blockPos.x + offset.x, blockPos.y - 1, blockPos.z + offset.z);
                  if (bot.blockAt(testPos) && bot.blockAt(testPos).name !== 'air') {
                    bot.pathfinder.setGoal(new GoalNear(testPos.x, testPos.y + 1, testPos.z, 1));
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Brief wait for movement
                    break;
                  }
                }
              }
            }
            
            // Mine this block
            console.log(`[tree-mining] Mining ${block.name} at (${blockPos.x}, ${blockPos.y}, ${blockPos.z}) [${minedCount + 1}/${totalBlocks}]`);
            
            if (!bot.canDigBlock(block)) {
              console.log(`[tree-mining] Cannot dig ${block.name}, skipping`);
              continue;
            }
            
            await bot.lookAt(blockPos, true);
            
            let digTime;
            try {
              digTime = getEstimatedDigTime(block, bot.heldItem);
              if (!digTime || digTime <= 0) {
                digTime = block.name.includes('log') ? 3000 : 5000; // Basic fallback
              }
            } catch (error) {
              console.log(`[tree-mining] Error calculating dig time: ${error.message}, using fallback`);
              digTime = 5000; // 5 second fallback  
            }
            const timeout = Math.max(digTime * 2, 5000); // 2x dig time or 5 seconds
            
            await new Promise((resolve, reject) => {
              let diggingCompleted = false;
              
              const onDiggingCompleted = (targetBlock) => {
                if (targetBlock.position.equals(blockPos)) {
                  diggingCompleted = true;
                  bot.removeListener('diggingCompleted', onDiggingCompleted);
                  bot.removeListener('diggingAborted', onDiggingAborted);
                  resolve();
                }
              };
              
              const onDiggingAborted = (targetBlock) => {
                if (targetBlock.position.equals(blockPos)) {
                  bot.removeListener('diggingCompleted', onDiggingCompleted);
                  bot.removeListener('diggingAborted', onDiggingAborted);
                  resolve(); // Continue with next block even if one fails
                }
              };
              
              const timeoutId = setTimeout(() => {
                if (!diggingCompleted) {
                  bot.removeListener('diggingCompleted', onDiggingCompleted);
                  bot.removeListener('diggingAborted', onDiggingAborted);
                  bot.stopDigging();
                  resolve(); // Continue with next block even if timeout
                }
              }, timeout);
              
              bot.on('diggingCompleted', onDiggingCompleted);
              bot.on('diggingAborted', onDiggingAborted);
              
              bot.dig(block, true).catch(() => {
                bot.removeListener('diggingCompleted', onDiggingCompleted);
                bot.removeListener('diggingAborted', onDiggingAborted);
                clearTimeout(timeoutId);
                resolve(); // Continue even if digging fails
              });
            });
            
            minedCount++;
            
          } catch (error) {
            console.log(`[tree-mining] Error mining block: ${error.message}`);
            continue; // Continue with next block
          }
        }
        
        console.log(`[tree-mining] Completed! Mined ${minedCount}/${totalBlocks} tree blocks`);
        break;
      }
      case 'PLACE_AT': {
        const { x, y, z, hand = 'right' } = args;
        if ([x,y,z].some(v => typeof v !== 'number')) throw new Error('PLACE_AT requires x,y,z');
        
        const ref = bot.blockAt(new Vec3(x, y, z));
        if (!ref) throw new Error('No reference block at coords');
        
        // Look at the target position first
        await bot.lookAt(new Vec3(x, y + 1, z));
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
          await bot.lookAt(target.position);
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
    addToActionHistory({ action, args, horizon_ms }, 'completed');
    
    // Clear current action
    currentAction = null;
    actionStartTime = null;
    
  } catch (error) {
    logger.logAction({ action, args, horizon_ms }, 'failed', error);
    addToActionHistory({ action, args, horizon_ms }, 'failed', error.message);
    
    // Clear current action
    currentAction = null;
    actionStartTime = null;
    
    throw error;
  }
}

// ====== PROMPT BUILDER ======
function buildPrompt(observation, goal = CONFIG.defaultGoal) {
  const legend = 'MAP LEGEND: @=you, T=trees/logs, L=leaves, O=ores, G=grass, D=dirt, S=stone, ~=water, !=lava, M=mobs, H=chests, .=walkable, #=solid';
  const rules = [
    'Choose ONE action JSON from the schema. No text, no markdown.',
    'Avoid lava (!). Prefer walkable (.). Keep distance from mobs unless attacking.',
    'If hunger < 7, choose EAT. Use GOTO for navigation, not long MOVE chains.',
    'Use horizon_ms 200–800 unless crafting/mining needs longer.',
    'WATER SAFETY: If you are in water, the system will automatically swim to land first.',
    'Swimming takes longer than walking - plan accordingly for water crossings.',
    'Check "In Water" status in game state before planning movements.',
    'TREE DETECTION: Look for T symbols (trees/logs) in the detailed map with coordinates.',
    'MINING ACTIONS: Use MINE_AT for single blocks, MINE_TREE for entire trees (automatically finds all connected tree blocks).',
    'EXPLORATION: If no trees (T) visible and you keep going to same coordinates, explore 15+ blocks away.',
    'COORDINATE USAGE: Use the boundary coordinates shown in the map for navigation planning.',
    'STUCK DETECTION: If recent actions complete in 0.0s, you are at target already - go somewhere else!',
    '🤖 BEHAVIORAL INTELLIGENCE: Pay attention to intelligence analysis - it detects patterns and suggests better actions.',
    '⚡ SMART TRANSITIONS: If you reach trees via GOTO, immediately switch to MINE_TREE instead of repeating GOTO.',
    '🎯 CONTEXT AWARENESS: When trees are detected and you are close, prioritize mining over more movement.',
    '🔍 PATTERN BREAKING: If you repeat the same action 3+ times, try a completely different approach.'
  ].join(' ');

  const fewshot = `
Examples (Return only one JSON object):
{"action":"MOVE","args":{"forward":true,"ms":500},"horizon_ms":500}
{"action":"EAT","args":{},"horizon_ms":400}
{"action":"GOTO","args":{"x":${Math.round(observation.position.x)+15},"y":${Math.round(observation.position.y)},"z":${Math.round(observation.position.z)+15},"radius":3},"horizon_ms":800}
{"action":"MINE_AT","args":{"x":${Math.round(observation.position.x)+1},"y":${Math.round(observation.position.y)},"z":${Math.round(observation.position.z)}},"horizon_ms":3000}
{"action":"MINE_TREE","args":{"x":${Math.round(observation.position.x)+2},"y":${Math.round(observation.position.y)},"z":${Math.round(observation.position.z)+1}},"horizon_ms":10000}
{"action":"LOOK_AT","args":{"x":${Math.round(observation.position.x)},"y":${Math.round(observation.position.y)+1},"z":${Math.round(observation.position.z)}},"horizon_ms":200}

🎯 SMART ACTION SELECTION:
- Use MINE_TREE when trees are detected and you're within 3 blocks
- Use GOTO to move to tree locations, then immediately switch to MINE_TREE
- DON'T keep using GOTO if you're already close to trees!

EXPLORATION EXAMPLES (when no trees visible):
{"action":"GOTO","args":{"x":${Math.round(observation.position.x)-25},"y":${Math.round(observation.position.y)},"z":${Math.round(observation.position.z)},"radius":2},"horizon_ms":1200}
{"action":"GOTO","args":{"x":${Math.round(observation.position.x)},"y":${Math.round(observation.position.y)},"z":${Math.round(observation.position.z)+25},"radius":2},"horizon_ms":1200}
{"action":"GOTO","args":{"x":${Math.round(observation.position.x)+20},"y":${Math.round(observation.position.y)},"z":${Math.round(observation.position.z)-20},"radius":2},"horizon_ms":1200}
`.trim();

  const systemPrompt = `You are an intelligent Minecraft bot agent. Your role is to analyze the game state and choose the best action to achieve your goals.

You must output exactly ONE JSON action matching this schema:
{"action":"MOVE|LOOK_AT|GOTO|MINE_AT|MINE_TREE|PLACE_AT|ATTACK_NEAREST|SELECT_HOTBAR|EAT|CRAFT","args":{...},"horizon_ms":400}

${legend}
${rules}

${fewshot}

IMPORTANT: Consider your previous actions to avoid repeating mistakes and to continue building on your progress. Learn from what worked and what didn't.

CRITICAL: Return ONLY a single JSON object with no markdown, no code blocks, no explanations, no commentary. Just the raw JSON object.`;

  const actionHistoryText = getActionHistoryForPrompt();

  const userPrompt = `Current Goal: ${goal}

=== RECENT ACTION HISTORY ===
${actionHistoryText}

=== CURRENT GAME STATE ===
Position: ${JSON.stringify(observation.position)}
Health: ${observation.health}/20, Hunger: ${observation.hunger}/20
Game Dimension: ${observation.dimension || 'overworld'}
Time of Day: ${observation.timeOfDay || 'unknown'}
Biome: ${observation.biome || 'unknown'}

=== INVENTORY & EQUIPMENT ===
Full Inventory: ${JSON.stringify(observation.inventory_summary)}
Hotbar: ${JSON.stringify(observation.hotbar)}

=== NEARBY ENTITIES ===
${observation.nearby_entities.length > 0 ? 
  observation.nearby_entities.map(e => 
    `${e.type} at (${e.pos.x.toFixed(1)}, ${e.pos.y.toFixed(1)}, ${e.pos.z.toFixed(1)}) - distance: ${e.distance.toFixed(1)}`
  ).join('\n') : 'No entities nearby'}

=== ADVANCED TREE DETECTION (via Mineflayer API) ===
${observation.nearby_trees && observation.nearby_trees.length > 0 ? 
  `🌳 TREES DETECTED: ${observation.nearby_trees.length} trees found within ${CONFIG.mapping.radius + 8} blocks!\n` + 
  observation.nearby_trees.slice(0, 5).map(t => 
    `  ${t.type} at (${t.pos.x}, ${t.pos.y}, ${t.pos.z}) - distance: ${t.distance.toFixed(1)} blocks`
  ).join('\n') + 
  (observation.nearby_trees.length > 5 ? `\n  ... and ${observation.nearby_trees.length - 5} more trees` : '') :
  '❌ NO TREES DETECTED: No trees found within scanning range. You need to explore further!'}

=== BEHAVIORAL INTELLIGENCE ANALYSIS ===
${buildIntelligenceContext(observation)}

=== GOAL SYSTEM STATUS ===
${CONFIG.goalSystem.enabled && goalSystem ? buildGoalSystemStatus() : '🎯 Goal System: DISABLED'}

=== NEARBY ORES ===
${observation.nearby_ores && observation.nearby_ores.length > 0 ? 
  `⛏️ ORES DETECTED: ${observation.nearby_ores.length} ore blocks found!\n` + 
  observation.nearby_ores.slice(0, 3).map(o => 
    `  ${o.type} at (${o.pos.x}, ${o.pos.y}, ${o.pos.z}) - distance: ${o.distance.toFixed(1)} blocks`
  ).join('\n') :
  '⛏️ NO ORES: No ore blocks detected in current area.'}

=== BLOCKS AHEAD ===
${observation.blocks_ahead.length > 0 ? 
  observation.blocks_ahead.map((block, i) => `${i+1}: ${block}`).join(', ') : 'None detected'}

=== ENVIRONMENTAL ANALYSIS ===
${observation.render_hint || "No specific environmental hints"}

=== DETAILED CHUNK MAP WITH COORDINATES ===
${observation.minimap_ascii || "(map not available)"}

STRATEGIC ANALYSIS:
Based on your goal "${goal}" and the comprehensive data above, consider:

🌳 TREE ANALYSIS:
${observation.nearby_trees && observation.nearby_trees.length > 0 ? 
  `✅ SUCCESS: ${observation.nearby_trees.length} trees detected! Use the exact coordinates above.\n` +
  `📍 CLOSEST TREE: ${observation.nearby_trees[0].type} at (${observation.nearby_trees[0].pos.x}, ${observation.nearby_trees[0].pos.y}, ${observation.nearby_trees[0].pos.z})\n` +
  `🎯 RECOMMENDED ACTION: GOTO (${observation.nearby_trees[0].pos.x}, ${observation.nearby_trees[0].pos.y}, ${observation.nearby_trees[0].pos.z}) then MINE_AT` :
  `❌ NO TREES: No trees found in ${CONFIG.mapping.radius + 8} block radius.\n` +
  `🚀 EXPLORATION NEEDED: Try coordinates outside current map boundaries:\n` +
  `   • North: Z > ${Math.round(observation.position.z) + CONFIG.mapping.radius}\n` +
  `   • South: Z < ${Math.round(observation.position.z) - CONFIG.mapping.radius}\n` +
  `   • East: X > ${Math.round(observation.position.x) + CONFIG.mapping.radius}\n` +
  `   • West: X < ${Math.round(observation.position.x) - CONFIG.mapping.radius}`}

🗺️ NAVIGATION STRATEGY:
- Current map shows ${CONFIG.mapping.radius*2+1}x${CONFIG.mapping.radius*2+1} area
- Boundary coordinates are shown for planning longer journeys
- Use specific coordinates from tree detection for precise navigation

🎯 ACTION PRIORITY (based on current situation):
${observation.nearby_trees && observation.nearby_trees.length > 0 ? 
  '1. 🌳 Trees found → Navigate to closest tree → Mine it\n2. 🔄 Continue mining until inventory full\n3. 🏠 Return to base/craft items' :
  '1. 🔍 No trees → Explore beyond current boundaries\n2. 🚀 Pick direction with least explored terrain\n3. 🌍 Look for forest biomes (avoid deserts/sand areas)'}

What action should you take next to best achieve your goal?`;

  return {
    systemPrompt,
    userPrompt
  };
}

// ====== AUTO MODE FUNCTIONS ======
async function executeLLMDecision(goal = CONFIG.defaultGoal) {
  try {
    // Check if we're at the action limit
    if (logger.actionCount >= CONFIG.autoMode.maxActions) {
      logger.logSystem(`Reached max actions limit (${CONFIG.autoMode.maxActions}), stopping auto mode`);
      stopAutoMode();
      return false;
    }

    // Check if an action is currently in progress
    if (CONFIG.actionSync.enabled && isActionInProgress()) {
      logger.logSystem('Skipping LLM decision: action still in progress', { 
        currentAction: currentAction?.action,
        elapsed: actionStartTime ? Date.now() - actionStartTime : 0
      });
      return false;
    }

    // ===== BEHAVIORAL INTELLIGENCE INTEGRATION =====
    // Update position tracking and detect patterns
    updatePositionTracking(bot);
    const isStuck = detectStuckBehavior();
    
    // Check for intelligent override
    const intelligentOverride = getIntelligentOverride(bot);
    if (intelligentOverride) {
      console.log(`[INTELLIGENCE] 🚀 Executing intelligent override:`, intelligentOverride);
      
      // Track the override action
      updateActionMemory(intelligentOverride);
      botIntelligence.lastLLMDecision = intelligentOverride;
      
      // Execute the override action directly
      await doAction(intelligentOverride);
      if (LOG.actionExec) console.log('[act] intelligent override executed');
      return true;
    }

    const obs = buildObservation();
    if (!obs.ready) {
      logger.logSystem('Bot not ready for LLM decision');
      return false;
    }

    const { systemPrompt, userPrompt } = buildPrompt(obs, goal);

    // Log prompt to separate file
    const promptDetails = {
      timestamp: new Date().toISOString(),
      goal: goal,
      systemPrompt: systemPrompt,
      userPrompt: userPrompt
    };
    logger.writeToSeparateFile('prompts', `GOAL: ${goal}\n\nSYSTEM PROMPT:\n${systemPrompt}\n\nUSER PROMPT:\n${userPrompt}`);

    if (LOG.promptPreview) {
      const preview = userPrompt.replace(/\s+/g, ' ').slice(0, 240);
      console.log('[llm] prompt preview:', preview + ' ...');
    }

    const llmReq = {
      model: CONFIG.llm.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: CONFIG.llm.temperature,
      max_tokens: CONFIG.llm.maxTokens,
      stream: false
    };

    const resp = await fetch(CONFIG.llm.url, {
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

    const modelText = data?.choices?.[0]?.message?.content?.trim() || '';
    if (LOG.llmText) console.log('[llm] text:', modelText.split('\n')[0]?.slice(0, 300));

    // Remove markdown code blocks if present
    let cleanText = modelText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    
    // Look for JSON object
    const match = cleanText.match(/\{[\s\S]*\}/);
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

    logger.logLLM(systemPrompt + '\n\n' + userPrompt, modelText, action);
    
    // ===== TRACK LLM DECISION IN BEHAVIORAL INTELLIGENCE =====
    updateActionMemory(action);
    botIntelligence.lastLLMDecision = action;
    
    // Context-aware decision enhancement
    if (shouldUseContextAwareDecision(bot)) {
      console.log(`[INTELLIGENCE] 🎯 Context suggests mining action might be more appropriate`);
    }
    
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
    const { systemPrompt, userPrompt } = buildPrompt(obs, CONFIG.defaultGoal);
    const fullPrompt = `SYSTEM PROMPT:\n${systemPrompt}\n\nUSER PROMPT:\n${userPrompt}`;
    res.type('text/plain').send(fullPrompt);
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

app.get('/debug/history', (_req, res) => {
  try {
    res.json({
      actionCount: actionHistory.length,
      maxHistory: CONFIG.actionHistory.maxHistory,
      history: actionHistory
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
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
  console.log(`[api] GET /debug/prompt -> view current prompt`);
  console.log(`[api] GET /debug/history -> view action history`);
  console.log(`[api] GET /auto/status -> auto mode status`);
  console.log(`[api] GET /logs?lines=100 -> recent log entries`);
  
  logger.logSystem('API server started', {
    port: CONFIG.apiPort,
    autoMode: CONFIG.autoMode.enabled,
    logging: CONFIG.logging.toFile ? CONFIG.logging.logFile : 'console only'
  });
});
