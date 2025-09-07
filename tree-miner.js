const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const minecraftData = require('minecraft-data')
const { Vec3 } = require('vec3')

// ALTERNATIVE: For easier scaffolding collection, you can use plugins:
// npm i mineflayer-collectblock mineflayer-tool
// const collectBlock = require('mineflayer-collectblock').plugin
// const toolPlugin = require('mineflayer-tool').plugin
// bot.loadPlugin(toolPlugin)
// bot.loadPlugin(collectBlock)

// ==== CONFIG: set these correctly ====
const HOST = '192.168.1.9'   // ← change if your server isn’t local
const PORT = 25565
const USERNAME = 'TreeAgent'
const AUTH = undefined      // 'microsoft' if your server is online-mode
// =====================================

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, auth: AUTH })
bot.loadPlugin(pathfinder)

// --- log everything important ---
bot.on('login', () => console.log('[BOT] login ok (handshake complete)'))
bot.on('spawn', () => console.log('[BOT] spawn event fired (world joined)'))
bot.on('kicked', r => console.log('[BOT] kicked:', r))
bot.on('end', r => console.log('[BOT] end:', r))
bot.on('error', e => console.log('[BOT] error:', e.message))
bot.on('chat', (u, m) => console.log(`[CHAT] <${u}> ${m}`))

// --- enchants patch: use the REAL resolved version (1.20.4 on your server) ---
bot.once('login', () => {
  try {
    const Item = require('prismarine-item')(bot.version) // must be a real version
    const desc = Object.getOwnPropertyDescriptor(Item.prototype, 'enchants')
    if (desc?.get) {
      const orig = desc.get
      Object.defineProperty(Item.prototype, 'enchants', {
        configurable: true, enumerable: true,
        get() { try { return orig.call(this) } catch { return [] } } // return [] instead of throw
      })
      console.log(`[PATCH] enchants getter patched for "${bot.version}"`)
    }
  } catch (e) { console.log('[PATCH] failed:', e.message) }
})

// --- helpers (mining flow uses official API + pathfinder patterns) ---
function isLog(block) { return !!block && /(_log|_stem)$/.test(block.name || '') }      // oak_log, crimson_stem, etc.
function neighbors(p) {
  return [p.offset(1,0,0), p.offset(-1,0,0), p.offset(0,1,0), p.offset(0,-1,0), p.offset(0,0,1), p.offset(0,0,-1)]
}

// --- combat helpers ---
function isHostileMob(entity) {
  if (!entity || !entity.name) return false
  const hostileMobs = [
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
    'zombified_piglin', 'piglin', 'hoglin', 'zoglin', 'blaze', 'ghast',
    'magma_cube', 'slime', 'phantom', 'drowned', 'husk', 'stray',
    'wither_skeleton', 'pillager', 'vindicator', 'evoker', 'ravager',
    'vex', 'guardian', 'elder_guardian', 'shulker', 'cave_spider',
    'silverfish', 'endermite', 'wither', 'ender_dragon'
  ]
  const entityName = entity.name.toLowerCase()
  return hostileMobs.some(mob => entityName.includes(mob))
}

function findNearbyHostiles(range = 8) {
  const entities = Object.values(bot.entities)
    .filter(entity => 
      entity.position && 
      entity !== bot.entity &&
      bot.entity.position.distanceTo(entity.position) <= range &&
      entity.isValid
    )
  
  // Try to find known hostiles first
  const knownHostiles = entities.filter(entity => isHostileMob(entity))
  
  if (knownHostiles.length > 0) {
    return knownHostiles.sort((a, b) => 
      bot.entity.position.distanceTo(a.position) - 
      bot.entity.position.distanceTo(b.position)
    )
  }
  
  // If no known hostiles but we're taking damage, return suspicious entities
  const suspicious = entities.filter(entity => 
    entity.mobType === 'hostile' || // Check mob type
    (entity.type === 'mob' && !entity.peaceful) || // Check if not peaceful
    entity.name?.toLowerCase().includes('monster') // Generic monster check
  )
  
  return suspicious.sort((a, b) => 
    bot.entity.position.distanceTo(a.position) - 
    bot.entity.position.distanceTo(b.position)
  )
}

async function equipWeapon() {
  const weapons = bot.inventory.items().filter(item => 
    /sword|axe|bow|crossbow|trident/.test(item.name)
  ).sort((a, b) => {
    // Prefer swords, then axes, then other weapons
    const aScore = a.name.includes('sword') ? 3 : a.name.includes('axe') ? 2 : 1
    const bScore = b.name.includes('sword') ? 3 : b.name.includes('axe') ? 2 : 1
    return bScore - aScore
  })
  
  if (weapons.length > 0) {
    const weapon = weapons[0]
    console.log(`[COMBAT] Equipping ${weapon.name} for combat`)
    try {
      await bot.equip(weapon, 'hand')
      return weapon
    } catch (e) {
      console.log(`[COMBAT] Failed to equip ${weapon.name}: ${e.message}`)
    }
  }
  
  console.log('[COMBAT] No weapons found, fighting with hands')
  return null
}

async function attackEntity(target, maxDuration = 10000) {
  console.log(`[COMBAT] Engaging ${target.name} at distance ${bot.entity.position.distanceTo(target.position).toFixed(1)}`)
  
  const startTime = Date.now()
  
  while (target.isValid && target.health > 0 && Date.now() - startTime < maxDuration) {
    const distance = bot.entity.position.distanceTo(target.position)
    
    if (distance > 6) {
      console.log('[COMBAT] Target too far, breaking off combat')
      break
    }
    
    // Look at the target
    await bot.lookAt(target.position.offset(0, target.height * 0.8, 0))
    
    try {
      // Attack if within range
      if (distance <= 4) {
        await bot.attack(target)
        console.log(`[COMBAT] Attacked ${target.name}`)
        await bot.waitForTicks(10) // Attack cooldown
      } else {
        // Move closer if too far
        bot.setControlState('forward', true)
        await bot.waitForTicks(2)
        bot.setControlState('forward', false)
      }
    } catch (e) {
      console.log(`[COMBAT] Attack failed: ${e.message}`)
      break
    }
    
    await bot.waitForTicks(1)
  }
  
  if (!target.isValid || target.health <= 0) {
    console.log(`[COMBAT] ✅ Defeated ${target.name}`)
  } else {
    console.log(`[COMBAT] Combat timeout or target escaped`)
  }
}

async function defendAgainstMobs() {
  const hostiles = findNearbyHostiles(8)
  
  if (hostiles.length === 0) return false
  
  console.log(`[COMBAT] ⚔️ ${hostiles.length} hostile mob(s) detected!`)
  bot.chat(`Under attack by ${hostiles.length} mob(s)!`)
  
  // Stop current pathfinding
  bot.pathfinder.setGoal(null)
  bot.pathfinder.stop()
  bot.clearControlStates()
  
  // Equip best weapon
  await equipWeapon()
  
  // Fight each hostile
  for (const hostile of hostiles) {
    if (!hostile.isValid) continue
    
    console.log(`[COMBAT] Fighting ${hostile.name}`)
    await attackEntity(hostile)
    
    // Brief pause between targets
    await bot.waitForTicks(5)
  }
  
  console.log('[COMBAT] Combat complete, resuming activities')
  bot.chat('Mobs defeated!')
  
  return true
}

// --- wood collection helpers ---
function countWoodInInventory() {
  const woodNames = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem']
  return bot.inventory.items()
    .filter(item => woodNames.some(wood => item.name.includes(wood) || item.name.includes('log') || item.name.includes('stem')))
    .reduce((sum, item) => sum + item.count, 0)
}

function getWoodStacks() {
  const woodCount = countWoodInInventory()
  return {
    count: woodCount,
    stacks: Math.floor(woodCount / 64),
    remainder: woodCount % 64,
    needed: Math.max(0, 128 - woodCount) // 2 full stacks = 128 blocks
  }
}

// --- scaffolding helpers ---
const SCAFFOLDING_NAMES = ['dirt', 'cobblestone', 'netherrack', 'sand', 'gravel'] // adjust to taste

function scaffoldingIds() {
  return SCAFFOLDING_NAMES
    .map(n => bot.registry.itemsByName[n]?.id)
    .filter(Boolean)
}

function countScaffoldingInInventory() {
  const ids = new Set(scaffoldingIds())
  return bot.inventory.items().reduce((sum, it) => sum + (ids.has(it.type) ? it.count : 0), 0)
}

function addScaffoldingToMovements(moves) {
  const ids = scaffoldingIds()
  for (const id of ids) {
    if (!moves.scafoldingBlocks.includes(id)) moves.scafoldingBlocks.push(id)
  }
}

// Mine nearby dirt/cobble blocks (within a radius) and pick up drops by walking over them
async function gatherScaffolding(minNeeded = 16, searchRadius = 16) {
  const have = countScaffoldingInInventory()
  if (have >= minNeeded) {
    console.log(`[SCAFFOLDING] Have ${have} blocks, no need to gather more`)
    return
  }

  const want = minNeeded - have
  console.log(`[SCAFFOLDING] Need ${want} more blocks (have ${have}, want ${minNeeded})`)
  bot.chat(`Gathering ${want} scaffolding blocks…`)

  const isScaffoldingBlock = (b) => b && SCAFFOLDING_NAMES.includes(b.name)
  const targets = bot.findBlocks({
    matching: (b) => isScaffoldingBlock(b),
    maxDistance: searchRadius,
    count: 64
  })

  // nothing found
  if (!targets.length) {
    console.log('[SCAFFOLDING] No scaffolding blocks found nearby')
    bot.chat('No scaffolding blocks found nearby.')
    return
  }

  console.log(`[SCAFFOLDING] Found ${targets.length} potential blocks to mine`)

  let collected = 0
  for (const p of targets) {
    if (collected >= want) break
    console.log(`[SCAFFOLDING] Mining block at (${p.x}, ${p.y}, ${p.z})`)
    
    // path to a face you can reach (same helper you already have)
    try {
      await approachReachableFace(new Vec3(p.x, p.y, p.z))
    } catch {
      console.log('[SCAFFOLDING] Failed to approach block, skipping')
      continue
    }
    
    const block = bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (!block || !isScaffoldingBlock(block)) {
      console.log('[SCAFFOLDING] Block changed after approach, skipping')
      continue
    }

    // equip shovel for dirt/sand/gravel if you have one
    const shovel = bot.inventory.items().find(i => /shovel/i.test(i.name))
    if (shovel) { 
      console.log(`[SCAFFOLDING] Equipping ${shovel.name} for efficient digging`)
      try { await bot.equip(shovel, 'hand') } catch {} 
    }

    // settle then dig (standard mineflayer dig pattern with events)
    await settleBeforeDig()
    try { 
      console.log(`[SCAFFOLDING] Digging ${block.name}`)
      await safeDig(block, 8000) 
    } catch (e) { 
      console.log(`[SCAFFOLDING] Failed to dig ${block.name}: ${e.message}`)
      continue 
    }

    // simple pickup: walk to the mined block location; the bot will vacuum the drop
    try { 
      await approachReachableFace(block.position) 
      console.log('[SCAFFOLDING] Moving to collect drops')
    } catch {}
    await bot.waitForTicks(10)

    const newCount = countScaffoldingInInventory()
    collected = newCount - have
    console.log(`[SCAFFOLDING] Progress: collected ${collected}/${want} blocks (total: ${newCount})`)
  }

  const finalCount = countScaffoldingInInventory()
  console.log(`[SCAFFOLDING] Gathering complete: now have ${finalCount} blocks`)
  bot.chat(`Scaffolding gathered: now have ${finalCount} blocks.`)
}

function floodLogsFrom(startPos, max = 96) {
  const seen = new Set(), q = [startPos], out = []
  const key = v => `${v.x}|${v.y}|${v.z}`
  while (q.length && out.length < max) {
    const v = q.shift(), k = key(v); if (seen.has(k)) continue
    seen.add(k)
    const b = bot.blockAt(v)
    if (!isLog(b)) continue
    out.push(b)
    neighbors(v).forEach(n => q.push(n))
  }
  out.sort((a,b) => a.position.y - b.position.y) // bottom→top
  return out
}

async function approachReachableFace(pos, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    // Reach any face within normal reach; pathfinder will pick a valid vantage point
    const g = new goals.GoalLookAtBlock(pos, bot.world, { reach: 4.5 })
    const finish = ok => { cleanup(); ok ? resolve() : reject(new Error('noPath/timeout')) }
    const onReached = () => { console.log('[MOVE] reached viewable position'); finish(true) }
    const onUpdate = r => { 
      if (r.status === 'noPath' || r.status === 'timeout') { 
        console.log('[MOVE] path fail:', r.status); finish(false) 
      }
    }
    const cleanup = () => {
      clearTimeout(t)
      bot.removeListener('goal_reached', onReached)
      bot.removeListener('path_update', onUpdate)
      bot.pathfinder.setGoal(null)
    }
    const t = setTimeout(() => { console.log('[MOVE] path timeout'); finish(false) }, timeoutMs)

    bot.on('goal_reached', onReached)
    bot.on('path_update', onUpdate)
    bot.pathfinder.setGoal(g)
  })
}

async function settleBeforeDig() {
  console.log('[PREP] Stopping all movement and rotation before digging')
  bot.pathfinder.stop()
  bot.pathfinder.setGoal(null)
  bot.clearControlStates()
  
  // Stop any residual movement
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('jump', false)
  bot.setControlState('sneak', false)
  
  await bot.waitForTicks(5)  // Longer wait to ensure complete stop
  
  // Check if bot is still moving
  const vel = bot.entity.velocity
  const stillMoving = Math.abs(vel.x) + Math.abs(vel.y) + Math.abs(vel.z) > 0.01
  if (stillMoving) {
    console.log('[PREP] Bot still moving, waiting longer...')
    await bot.waitForTicks(10)
  }
  
  console.log('[PREP] Bot fully settled and ready to dig')
}

async function safeDig(block, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(t)
      bot.removeListener('diggingCompleted', onDone)
      bot.removeListener('diggingAborted', onAbort)
    }
    const onDone  = dug => { if (dug.position.equals(block.position)) { cleanup(); resolve() } }
    const onAbort = dug => { if (dug.position.equals(block.position)) { cleanup(); reject(new Error('Digging aborted')) } }
    const t = setTimeout(() => { cleanup(); reject(new Error('dig timeout')) }, timeoutMs)

    bot.on('diggingCompleted', onDone)  // official dig events. :contentReference[oaicite:2]{index=2}
    bot.on('diggingAborted',  onAbort)

    bot.dig(block, true).catch(err => {
      cleanup()
      if (/enchants/i.test(String(err?.message))) return reject(new Error('enchants-unknown'))
      reject(err)
    })
  })
}

async function equipAxeIfAny() {
  const axe = bot.inventory.items().find(i => /axe/i.test(i.name))
  if (axe) {
    console.log(`[TOOL] Equipping ${axe.name} for wood mining`)
    try { 
      await bot.equip(axe, 'hand')
      console.log(`[TOOL] Successfully equipped ${axe.name}`)
    } catch (e) {
      console.log(`[TOOL] Failed to equip axe: ${e.message}`)
    }
  } else {
    console.log('[TOOL] No axe found, mining with hand (will be slower)')
  }
}

// --- tree routine (with wood collection goal) ---
async function mineTreesForWood() {
  const targetStacks = 2 // Goal: 2 full stacks (128 wood blocks)
  let attempts = 0
  const maxAttempts = 10 // Safety limit to prevent infinite loops
  const failedBlocks = new Set() // Track blocks that failed to mine
  
  while (attempts < maxAttempts) {
    attempts++
    
    const woodStats = getWoodStacks()
    console.log(`[WOOD] Current inventory: ${woodStats.count} wood blocks (${woodStats.stacks} full stacks + ${woodStats.remainder})`)
    
    if (woodStats.stacks >= targetStacks) {
      console.log(`[WOOD] 🎉 Goal achieved! Have ${woodStats.stacks} full stacks of wood`)
      bot.chat(`Mission complete! Collected ${woodStats.count} wood blocks (${woodStats.stacks} full stacks)`)
      return
    }
    
    console.log(`[WOOD] Need ${woodStats.needed} more wood blocks to reach goal`)
    bot.chat(`Collecting wood: ${woodStats.count}/128 blocks (${woodStats.stacks}/2 stacks)`)
    
    // Find trees, excluding failed blocks
    console.log(`[TREE] Attempt ${attempts}: Scanning for trees...`)
    const hits = bot.findBlocks({ matching: b => b && isLog(b), maxDistance: 48, count: 100 })
    
    if (!hits.length) {
      console.log('[TREE] No trees found, expanding search area...')
      const wideHits = bot.findBlocks({ matching: b => b && isLog(b), maxDistance: 80, count: 100 })
      hits.push(...wideHits)
    }
    
    if (!hits.length) {
      console.log('[TREE] No trees found in expanded area')
      bot.chat('No more trees found nearby. May need to explore further.')
      break
    }
    
    // Filter out failed blocks and find a good tree
    let bestTree = null
    let bestSize = 0
    
    for (const pos of hits) {
      const blockKey = `${pos.x},${pos.y},${pos.z}`
      if (failedBlocks.has(blockKey)) continue
      
      const trunk = floodLogsFrom(pos, 96)
      if (trunk.length > bestSize) {
        bestTree = { start: pos, trunk }
        bestSize = trunk.length
      }
      
      // If we find a decent sized tree, use it
      if (bestSize >= 3) break
    }
    
    if (!bestTree || bestTree.trunk.length === 0) {
      console.log('[TREE] No suitable trees found, may need to explore further')
      bot.chat('No suitable trees found nearby.')
      break
    }
    
    console.log(`[TREE] Selected tree with ${bestTree.trunk.length} logs at (${bestTree.start.x}, ${bestTree.start.y}, ${bestTree.start.z})`)
    
    // Configure pathfinder for this tree
    const mcData = minecraftData(bot.version)
    const moves = new Movements(bot, mcData)
    
    moves.canDig = true
    moves.digCost = 1
    moves.placeCost = 1
    moves.allow1by1towers = true
    moves.allowParkour = true
    
    addScaffoldingToMovements(moves)
    bot.pathfinder.setMovements(moves)
    bot.pathfinder.thinkTimeout = 8000
    
    // Ensure scaffolding only if we don't have enough
    const scaffoldingCount = countScaffoldingInInventory()
    if (scaffoldingCount < 8) {
      console.log('[SCAFFOLDING] Need more building blocks for complex terrain')
      await gatherScaffolding(16)
    }

    // Mine this tree
    let mined = 0, failed = 0
    const woodBefore = countWoodInInventory()
    
    for (const blk of bestTree.trunk) {
      const blockKey = `${blk.position.x},${blk.position.y},${blk.position.z}`
      
      // Skip if this block failed before
      if (failedBlocks.has(blockKey)) {
        console.log(`[MINE] Skipping previously failed block at ${blockKey}`)
        continue
      }
      
      console.log(`[MINE] Processing log ${mined + failed + 1}/${bestTree.trunk.length}: ${blk.name} at (${blk.position.x}, ${blk.position.y}, ${blk.position.z})`)
      
      // Check for hostiles before approaching each block
      const hostiles = findNearbyHostiles(8)
      if (hostiles.length > 0) {
        console.log(`[MINE] Hostiles detected while mining, defending first...`)
        await defendAgainstMobs()
        // Re-equip axe after combat
        await equipAxeIfAny()
      }
      
      try { 
        await approachReachableFace(blk.position) 
      } catch (e) { 
        console.log(`[MINE] Failed to reach face: ${e.message}`)
        failedBlocks.add(blockKey)
        failed++; continue 
      }
      
      const fresh = bot.blockAt(blk.position)
      if (!isLog(fresh)) {
        console.log('[MINE] Block changed, skipping')
        continue
      }

      // Equip tool first
      await equipAxeIfAny()
      
      // Look at center of block
      const centerPos = new Vec3(fresh.position.x + 0.5, fresh.position.y + 0.5, fresh.position.z + 0.5)
      console.log(`[MINE] Looking at block center: (${centerPos.x}, ${centerPos.y}, ${centerPos.z})`)
      await bot.lookAt(centerPos, true)
      
      // Ensure complete stop
      await settleBeforeDig()
      
      try { 
        console.log(`[MINE] Starting to dig ${fresh.name}`)
        await safeDig(fresh, 15000) // Longer timeout
        mined++; 
        console.log(`[MINE] ✅ Successfully mined ${fresh.name}`)
        await bot.waitForTicks(5) // Extra time for item pickup
        
        const currentWood = countWoodInInventory()
        console.log(`[MINE] Progress: ${mined} mined, ${currentWood} total wood`)
      }
      catch (e) { 
        console.log(`[MINE] ❌ Failed to dig: ${e.message}`)
        failedBlocks.add(blockKey)
        if (e.message !== 'enchants-unknown') failed++ 
      }
    }
    
    const woodAfter = countWoodInInventory()
    const woodGained = woodAfter - woodBefore
    console.log(`[TREE] Tree complete: gained ${woodGained} wood (${mined} blocks mined, ${failed} failed)`)
    
    // If we didn't mine anything from this tree, mark it as problematic
    if (mined === 0) {
      console.log('[TREE] No blocks mined from this tree, looking for different trees')
    }
    
    // Brief pause before next tree to let items settle
    console.log('[WOOD] Pausing to collect any remaining drops...')
    await bot.waitForTicks(20)
  }
  
  const finalStats = getWoodStacks()
  if (finalStats.stacks < targetStacks) {
    console.log(`[WOOD] Could not reach goal after ${maxAttempts} attempts`)
    console.log(`[WOOD] Final count: ${finalStats.count} wood blocks (${finalStats.stacks} full stacks)`)
    bot.chat(`Collected ${finalStats.count} wood blocks, but couldn't reach 2 full stacks. May need to explore further.`)
  }
}

// --- start after spawn (with wood collection goal) ---
bot.once('spawn', async () => {
  console.log('[START] 🎯 Mission: Collect 2 full stacks of wood (128 blocks)')
  console.log('[START] Waiting 2s for chunks to load...')
  await bot.waitForTicks(40) // ~2 seconds
  
  const initialWood = getWoodStacks()
  console.log(`[START] Starting inventory: ${initialWood.count} wood blocks`)
  
  try { 
    await mineTreesForWood() 
  } catch (e) { 
    console.log('[START] Wood collection error:', e.message)
    bot.chat('Wood collection failed: ' + e.message)
  }
})

// --- combat event handlers ---
bot.on('entityHurt', async (entity) => {
  if (entity === bot.entity) {
    console.log(`[COMBAT] 🩸 Bot took damage! Health: ${bot.health}/20`)
    
    // IMMEDIATE combat response when taking damage
    console.log(`[COMBAT] Scanning for attackers...`)
    const hostiles = findNearbyHostiles(16) // Expanded search range
    if (hostiles.length > 0) {
      console.log(`[COMBAT] Found ${hostiles.length} hostile(s), engaging immediately!`)
      try {
        await defendAgainstMobs()
      } catch (e) {
        console.log(`[COMBAT] Emergency combat failed: ${e.message}`)
      }
    } else {
      // If no hostiles found, scan for ALL nearby entities
      console.log(`[COMBAT] No hostiles detected, scanning all entities...`)
      const allEntities = Object.values(bot.entities)
        .filter(e => 
          e.position && 
          e !== bot.entity && 
          bot.entity.position.distanceTo(e.position) <= 12 &&
          e.isValid
        )
        .sort((a, b) => 
          bot.entity.position.distanceTo(a.position) - 
          bot.entity.position.distanceTo(b.position)
        )
      
      console.log(`[COMBAT] Found ${allEntities.length} entities nearby:`)
      allEntities.slice(0, 5).forEach(e => {
        const dist = bot.entity.position.distanceTo(e.position).toFixed(1)
        console.log(`[COMBAT] - ${e.name || 'unknown'} at distance ${dist}`)
      })
      
      // Attack closest entity that might be hostile
      if (allEntities.length > 0) {
        const suspect = allEntities[0]
        console.log(`[COMBAT] Attacking closest entity: ${suspect.name || 'unknown'}`)
        try {
          await attackEntity(suspect, 5000)
        } catch (e) {
          console.log(`[COMBAT] Failed to attack suspect: ${e.message}`)
        }
      }
    }
  }
})

bot.on('entityDead', (entity) => {
  if (isHostileMob(entity)) {
    console.log(`[COMBAT] ✅ Hostile mob defeated: ${entity.name}`)
  }
})

// Periodic combat check
setInterval(async () => {
  try {
    // More aggressive scanning when health is low
    const range = bot.health < 15 ? 12 : 8
    const hostiles = findNearbyHostiles(range)
    
    if (hostiles.length > 0) {
      console.log(`[COMBAT] Periodic check: ${hostiles.length} hostile(s) nearby (health: ${bot.health}/20)`)
      await defendAgainstMobs()
    } else if (bot.health < 10) {
      // Emergency scan when very low health
      console.log(`[COMBAT] Low health emergency scan...`)
      const allEntities = Object.values(bot.entities)
        .filter(e => 
          e.position && 
          e !== bot.entity && 
          bot.entity.position.distanceTo(e.position) <= 8 &&
          e.isValid
        )
      
      if (allEntities.length > 0) {
        console.log(`[COMBAT] Emergency: attacking nearest entity`)
        const target = allEntities.sort((a, b) => 
          bot.entity.position.distanceTo(a.position) - 
          bot.entity.position.distanceTo(b.position)
        )[0]
        
        await equipWeapon()
        await attackEntity(target, 3000)
      }
    }
  } catch (e) {
    console.log(`[COMBAT] Error in periodic combat check: ${e.message}`)
  }
}, 1500) // Check every 1.5 seconds (more frequent)

// --- manual trigger: type "/wood" in Minecraft chat ---
bot.on('chat', async (u, m) => {
  if (u === bot.username) return
  if (m.toLowerCase() === '/wood') {
    const stats = getWoodStacks()
    bot.chat(`Current wood: ${stats.count} blocks (${stats.stacks} stacks + ${stats.remainder}). Need ${stats.needed} more.`)
    if (stats.needed > 0) {
      bot.chat('Resuming wood collection...')
      try { await mineTreesForWood() } catch (e) { bot.chat('Collection error: ' + e.message) }
    }
  }
  if (m.toLowerCase() === '/mine') {
    bot.chat('Starting wood collection mission...')
    try { await mineTreesForWood() } catch (e) { bot.chat('Mine error: ' + e.message) }
  }
  if (m.toLowerCase() === '/fight') {
    bot.chat('Checking for hostiles...')
    const hostiles = findNearbyHostiles(16)
    if (hostiles.length > 0) {
      bot.chat(`Found ${hostiles.length} hostile(s), engaging!`)
      try { await defendAgainstMobs() } catch (e) { bot.chat('Combat error: ' + e.message) }
    } else {
      bot.chat('No hostiles found nearby.')
    }
  }
  if (m.toLowerCase() === '/health') {
    bot.chat(`Health: ${bot.health}/20, Food: ${bot.food}/20`)
  }
  if (m.toLowerCase() === '/panic') {
    bot.chat('PANIC MODE: Attacking all nearby entities!')
    const allEntities = Object.values(bot.entities)
      .filter(e => 
        e.position && 
        e !== bot.entity && 
        bot.entity.position.distanceTo(e.position) <= 10 &&
        e.isValid
      )
      .sort((a, b) => 
        bot.entity.position.distanceTo(a.position) - 
        bot.entity.position.distanceTo(b.position)
      )
    
    bot.chat(`Found ${allEntities.length} entities nearby`)
    for (const entity of allEntities.slice(0, 3)) {
      const dist = bot.entity.position.distanceTo(entity.position).toFixed(1)
      bot.chat(`Attacking ${entity.name || 'unknown'} at ${dist} blocks`)
      try {
        await equipWeapon()
        await attackEntity(entity, 5000)
      } catch (e) {
        bot.chat(`Failed to attack: ${e.message}`)
      }
    }
  }
  if (m.toLowerCase() === '/scan') {
    const allEntities = Object.values(bot.entities)
      .filter(e => 
        e.position && 
        e !== bot.entity && 
        bot.entity.position.distanceTo(e.position) <= 15 &&
        e.isValid
      )
      .sort((a, b) => 
        bot.entity.position.distanceTo(a.position) - 
        bot.entity.position.distanceTo(b.position)
      )
    
    bot.chat(`Entities within 15 blocks: ${allEntities.length}`)
    allEntities.slice(0, 5).forEach((e, i) => {
      const dist = bot.entity.position.distanceTo(e.position).toFixed(1)
      const hostile = isHostileMob(e) ? '[HOSTILE]' : '[NEUTRAL]'
      bot.chat(`${i+1}. ${e.name || 'unknown'} ${hostile} - ${dist}m`)
    })
  }
})
