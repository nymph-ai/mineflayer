const mineflayer = require('..')
const gatherWoodPlugin = require('../plugins/gather-wood')

const host = process.env.MINEFLAYER_HOST || '127.0.0.1'
const port = Number.parseInt(process.env.MINEFLAYER_PORT || '25565', 10)
const username = process.env.MINEFLAYER_USERNAME || 'mineflayer-bot'
const auth = process.env.MINEFLAYER_AUTH || 'offline'
const version = process.env.MINEFLAYER_VERSION || '1.21.11'
const dataVersion = process.env.MINEFLAYER_DATA_VERSION || version
const protocolVersion = process.env.MINEFLAYER_PROTOCOL_VERSION
  ? Number.parseInt(process.env.MINEFLAYER_PROTOCOL_VERSION, 10)
  : undefined
const clientVersion = process.env.MINEFLAYER_CLIENT_VERSION || undefined
const chatMessage = process.env.MINEFLAYER_CHAT || ''
const connectTimeoutMs = Number.parseInt(process.env.MINEFLAYER_CONNECT_TIMEOUT_MS || '20000', 10)
const logVelocity = process.env.MINEFLAYER_LOG_VELOCITY === '1'
const logPosition = process.env.MINEFLAYER_LOG_POSITION === '1'

console.log(`[mineflayer-bot] opts dataVersion=${dataVersion} clientVersion=${clientVersion ?? 'default'} protocolVersion=${protocolVersion ?? 'default'}`)
const mcData = require('minecraft-data')(dataVersion)
if (mcData?.version) {
  console.log(`[mineflayer-bot] mcData ${mcData.version.minecraftVersion} protocol ${mcData.version.version}`)
} else {
  console.log(`[mineflayer-bot] mcData not found for ${dataVersion}`)
}

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth,
  version: dataVersion,
  protocolVersion,
  clientVersion
})

bot.loadPlugin(gatherWoodPlugin)
bot.on('messagestr', async (message, position) => {
  if (position !== 'chat') return
  const match = message.match(/gather wood(?:\s+(\d+))?$/i)
  if (!match) return
  bot.chat('On it.')
  const count = Number.parseInt(match[1] || '16', 10)
  try {
    const total = await bot.behaviors.gatherWood(count)
    bot.chat(`Got ${total} logs.`)
  } catch (err) {
    bot.chat(`Gather failed: ${err.message}`)
  }
})

const timeout = setTimeout(() => {
  console.error(`[mineflayer-bot] Timed out waiting for spawn after ${connectTimeoutMs}ms`)
  bot.end()
  process.exit(1)
}, connectTimeoutMs)

bot.once('spawn', () => {
  clearTimeout(timeout)
  console.log('[mineflayer-bot] Spawned successfully')
  console.log(`[mineflayer-bot] entityId=${bot.entity.id}`)
  if (bot.game?.gameMode !== undefined) {
    console.log(`[mineflayer-bot] gameMode=${bot.game.gameMode}`)
  }
  const spawnBlock = bot.blockAt(bot.entity.position, false)
  console.log(`[mineflayer-bot] spawnBlock=${spawnBlock ? spawnBlock.name : 'unloaded'}`)
  if (chatMessage) bot.chat(chatMessage)
})

if (logVelocity) {
  bot._client.on('entity_velocity', (packet) => {
    if (packet.entityId !== bot.entity?.id) return
    if (packet.velocity) {
      console.log('[mineflayer-bot] velocity', packet.velocity)
      return
    }
    console.log('[mineflayer-bot] velocity', {
      velocityX: packet.velocityX,
      velocityY: packet.velocityY,
      velocityZ: packet.velocityZ
    })
  })
}

if (logPosition) {
  bot._client.on('position', (packet) => {
    if (packet.dx || packet.dy || packet.dz) {
      console.log('[mineflayer-bot] position', {
        x: packet.x,
        y: packet.y,
        z: packet.z,
        dx: packet.dx,
        dy: packet.dy,
        dz: packet.dz,
        flags: packet.flags
      })
    }
  })
}

bot.on('end', () => {
  console.log('[mineflayer-bot] Disconnected')
  process.exit(0)
})

bot.on('error', (err) => {
  clearTimeout(timeout)
  console.error('[mineflayer-bot] Error', err)
  process.exit(1)
})
