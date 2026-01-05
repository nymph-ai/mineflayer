const mineflayer = require('..')

const host = process.env.MINEFLAYER_HOST || '127.0.0.1'
const port = Number.parseInt(process.env.MINEFLAYER_PORT || '25565', 10)
const username = process.env.MINEFLAYER_USERNAME || 'mineflayer-bot'
const auth = process.env.MINEFLAYER_AUTH || 'offline'
const version = process.env.MINEFLAYER_VERSION || '1.21.11'
const chatMessage = process.env.MINEFLAYER_CHAT || ''
const connectTimeoutMs = Number.parseInt(process.env.MINEFLAYER_CONNECT_TIMEOUT_MS || '20000', 10)

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth,
  version
})

const timeout = setTimeout(() => {
  console.error(`[mineflayer-smoke] Timed out waiting for spawn after ${connectTimeoutMs}ms`)
  bot.end()
  process.exit(1)
}, connectTimeoutMs)

bot.once('spawn', () => {
  clearTimeout(timeout)
  console.log('[mineflayer-smoke] Spawned successfully')
  if (chatMessage) bot.chat(chatMessage)
  setTimeout(() => bot.end(), 2000)
})

bot.on('end', () => {
  console.log('[mineflayer-smoke] Disconnected')
  process.exit(0)
})

bot.on('error', (err) => {
  clearTimeout(timeout)
  console.error('[mineflayer-smoke] Error', err)
  process.exit(1)
})
