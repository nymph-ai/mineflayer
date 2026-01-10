'use strict'

try {
  require('node-canvas-webgl')
} catch (err) {
  throw new Error('node-canvas-webgl is not installed. Install it to use prismarine-viewer headless mode.')
}

const fs = require('fs')
const net = require('net')
const path = require('path')
const mineflayer = require('..')
const mineflayerViewer = require('prismarine-viewer').headless
const jpeg = require('jpeg-js')
const rclnodejs = require('rclnodejs')

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
const connectTimeoutMs = Number.parseInt(process.env.MINEFLAYER_CONNECT_TIMEOUT_MS || '20000', 10)

const frameHost = process.env.VLM_FRAME_HOST || '127.0.0.1'
const framePort = Number.parseInt(process.env.VLM_FRAME_PORT || '8089', 10)
const frameWidth = Number.parseInt(process.env.VLM_FRAME_WIDTH || '320', 10)
const frameHeight = Number.parseInt(process.env.VLM_FRAME_HEIGHT || '180', 10)
const viewDistance = Number.parseInt(process.env.VLM_VIEW_DISTANCE || '6', 10)
const frameQuality = Number.parseFloat(process.env.VLM_FRAME_QUALITY || '0.8')
const framePath = process.env.VLM_FRAME_PATH || '/data/vlm_frames/ego.jpg'
const oneShot = (process.env.VLM_ONESHOT || 'true').toLowerCase() === 'true'
const manualCapture = (process.env.VLM_CAPTURE_MANUAL || 'false').toLowerCase() === 'true'
const controlTickMs = Number.parseInt(process.env.VLM_CONTROL_TICK_MS || '50', 10)
const controlDeadzone = Number.parseFloat(process.env.VLM_CONTROL_DEADZONE || '0.05')
const controlTimeoutMs = Number.parseInt(process.env.VLM_CONTROL_TIMEOUT_MS || '500', 10)
const ros2Enabled = (process.env.ROS2_ENABLE || 'true').toLowerCase() !== 'false'
const cmdVelTopic = process.env.ROS2_CMD_VEL_TOPIC || '/cmd_vel'
const imageTopic = process.env.ROS2_IMAGE_TOPIC || '/player/image_raw'
const rosFrameId = process.env.ROS2_FRAME_ID || 'mineflayer_camera'

const vlmEndpoint = process.env.VLM_ENDPOINT || 'http://127.0.0.1:12000/v1/chat/completions'
const vlmModel = process.env.VLM_MODEL || 'qwen3-vl-30b-a3b-thinking-fp8'
const vlmSystemPrompt = process.env.VLM_SYSTEM_PROMPT || 'You describe what the bot sees for quick testing.'
const vlmUserPrompt = process.env.VLM_USER_PROMPT || 'Describe the scene from the bot perspective.'
const vlmTemperature = Number.parseFloat(process.env.VLM_TEMPERATURE || '0.2')
const vlmMaxTokens = Number.parseInt(process.env.VLM_MAX_TOKENS || '256', 10)
const vlmIntervalMs = Number.parseInt(process.env.VLM_INTERVAL_MS || '2000', 10)
const vlmTimeoutMs = Number.parseInt(process.env.VLM_HTTP_TIMEOUT_MS || '60000', 10)
const captureDelayMs = Number.parseInt(process.env.VLM_CAPTURE_DELAY_MS || '8000', 10)
const waitForChunksTimeoutMs = Number.parseInt(process.env.VLM_WAIT_CHUNKS_TIMEOUT_MS || '10000', 10)
const moveForwardMs = Number.parseInt(process.env.VLM_MOVE_FORWARD_MS || '0', 10)
const lookYawDeg = Number.parseFloat(process.env.VLM_LOOK_YAW_DEG || '0')
const lookPitchDeg = Number.parseFloat(process.env.VLM_LOOK_PITCH_DEG || '35')
const warmupFrames = Number.parseInt(process.env.VLM_WARMUP_FRAMES || '60', 10)

const physicsEnabled = (process.env.MINEFLAYER_ENABLE_PHYSICS || 'true').toLowerCase() !== 'false'
const allowDirectPosition = (process.env.MINEFLAYER_ALLOW_DIRECT_POSITION || 'false').toLowerCase() === 'true'

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth,
  version: dataVersion,
  protocolVersion,
  clientVersion,
  plugins: {
    physics: physicsEnabled
  }
})

let pendingFrame = null
let inflight = false
let lastSentAt = 0
let sendTimer = null
let processedOnce = false
let captureReadyAt = Date.now() + captureDelayMs
let remainingWarmup = warmupFrames
let sawPosition = false
let lastTwistAt = 0
const activeTwist = { linearX: 0, linearY: 0, angularZ: 0 }
let rosNode = null
let imagePub = null
let rosReady = false

function degToRad (deg) {
  return (deg * Math.PI) / 180
}

function decodeJpegToRgb (frame) {
  const decoded = jpeg.decode(frame, { useTArray: true })
  if (!decoded || !decoded.data) return null
  const rgb = Buffer.alloc(decoded.width * decoded.height * 3)
  let j = 0
  for (let i = 0; i < decoded.data.length; i += 4) {
    rgb[j++] = decoded.data[i]
    rgb[j++] = decoded.data[i + 1]
    rgb[j++] = decoded.data[i + 2]
  }
  return {
    width: decoded.width,
    height: decoded.height,
    data: rgb
  }
}

function makeHeader () {
  const nowMs = Date.now()
  return {
    stamp: {
      sec: Math.floor(nowMs / 1000),
      nanosec: (nowMs % 1000) * 1e6
    },
    frame_id: rosFrameId
  }
}

async function initRos2 () {
  if (!ros2Enabled || rosReady) return
  try {
    await rclnodejs.init()
  } catch (err) {
    logPrefix(`ROS2 init failed: ${err.message}`)
    return
  }
  rosNode = new rclnodejs.Node('mineflayer_vlm_bot')
  imagePub = rosNode.createPublisher('sensor_msgs/msg/Image', imageTopic)
  rosNode.createSubscription('geometry_msgs/msg/Twist', cmdVelTopic, (msg) => {
    const linX = Number.isFinite(msg.linear?.x) ? msg.linear.x : 0
    const linY = Number.isFinite(msg.linear?.y) ? msg.linear.y : 0
    const angZ = Number.isFinite(msg.angular?.z) ? msg.angular.z : 0
    activeTwist.linearX = linX
    activeTwist.linearY = linY
    activeTwist.angularZ = angZ
    lastTwistAt = Date.now()
  })
  rclnodejs.spin(rosNode)
  rosReady = true
  logPrefix(`ROS2 ready: ${imageTopic} <- frames, ${cmdVelTopic} -> twist`)
}

function publishFrame (frame) {
  if (!rosReady || !imagePub) return
  const decoded = decodeJpegToRgb(frame)
  if (!decoded) return
  imagePub.publish({
    header: makeHeader(),
    height: decoded.height,
    width: decoded.width,
    encoding: 'rgb8',
    is_bigendian: 0,
    step: decoded.width * 3,
    data: decoded.data
  })
}

function tryLook (yaw, pitch) {
  if (typeof bot.look === 'function') {
    bot.look(yaw, pitch, true)
    return
  }
  if (bot.entity) {
    bot.entity.yaw = yaw
    bot.entity.pitch = pitch
    bot.emit('move')
  }
}

function tryMoveForward (durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return
  if (typeof bot.setControlState === 'function') {
    bot.setControlState('forward', true)
    setTimeout(() => bot.setControlState('forward', false), durationMs)
    return
  }
  if (!allowDirectPosition) return
  const steps = Math.max(1, Math.floor(durationMs / 250))
  const stepSize = 0.4
  let remaining = steps
  const interval = setInterval(() => {
    if (!bot.entity?.position) {
      clearInterval(interval)
      return
    }
    const yaw = bot.entity.yaw || 0
    const dx = -Math.sin(yaw) * stepSize
    const dz = -Math.cos(yaw) * stepSize
    bot.entity.position = bot.entity.position.offset(dx, 0, dz)
    bot.emit('move')
    remaining -= 1
    if (remaining <= 0) clearInterval(interval)
  }, 250)
}

function setControlStates (linearX, linearY) {
  if (typeof bot.setControlState !== 'function') return false
  const forward = linearX > controlDeadzone
  const back = linearX < -controlDeadzone
  const left = linearY > controlDeadzone
  const right = linearY < -controlDeadzone
  bot.setControlState('forward', forward)
  bot.setControlState('back', back)
  bot.setControlState('left', left)
  bot.setControlState('right', right)
  return true
}

function applyActiveTwist (dtSeconds) {
  const now = Date.now()
  if (now - lastTwistAt > controlTimeoutMs) {
    activeTwist.linearX = 0
    activeTwist.linearY = 0
    activeTwist.angularZ = 0
  }

  const yaw = (bot.entity?.yaw || 0) + activeTwist.angularZ * dtSeconds
  const pitch = bot.entity?.pitch || 0
  if (Math.abs(activeTwist.angularZ) > 0) {
    tryLook(yaw, pitch)
  }

  const usedControls = setControlStates(activeTwist.linearX, activeTwist.linearY)
  if (usedControls) return

  if (!allowDirectPosition) return
  if (!bot.entity?.position) return
  const speed = 4
  const dx = (-Math.sin(yaw) * activeTwist.linearX + Math.cos(yaw) * activeTwist.linearY) * speed * dtSeconds
  const dz = (-Math.cos(yaw) * activeTwist.linearX - Math.sin(yaw) * activeTwist.linearY) * speed * dtSeconds
  if (dx === 0 && dz === 0) return
  bot.entity.position = bot.entity.position.offset(dx, 0, dz)
  bot.emit('move')
}

let controlTimer = null
function startControlLoop () {
  if (controlTimer) return
  let lastTick = Date.now()
  controlTimer = setInterval(() => {
    const now = Date.now()
    const dt = (now - lastTick) / 1000
    lastTick = now
    applyActiveTwist(dt)
  }, controlTickMs)
}

function logPrefix (message) {
  console.log(`[vlm-viewer] ${message}`)
}

function armCapture (reason) {
  if (Number.isFinite(captureReadyAt)) return
  captureReadyAt = Date.now() + captureDelayMs
  remainingWarmup = warmupFrames
  logPrefix(`capture armed (${reason})`)
}

bot.on('entityMoved', (entity) => {
  if (entity !== bot.entity) return
  if (sawPosition) return
  sawPosition = true
  const below = bot.blockAt?.(bot.entity.position.offset(0, -1, 0))
  logPrefix(`spawn pos=${bot.entity.position.toString()} block_below=${below?.name || 'unknown'}`)
  if (!manualCapture) {
    armCapture('position update')
  }
})

function queueFrame (frame) {
  publishFrame(frame)
  if (Date.now() < captureReadyAt) return
  if (remainingWarmup > 0) {
    remainingWarmup -= 1
    return
  }
  if (oneShot && (processedOnce || inflight)) return
  pendingFrame = frame
  if (inflight || sendTimer) return
  const elapsed = Date.now() - lastSentAt
  const waitMs = Math.max(0, vlmIntervalMs - elapsed)
  sendTimer = setTimeout(() => {
    sendTimer = null
    if (inflight || !pendingFrame) return
    const nextFrame = pendingFrame
    pendingFrame = null
    sendFrame(nextFrame).catch((err) => {
      logPrefix(`send failed: ${err.message}`)
    })
  }, waitMs)
}

async function sendFrame (frame) {
  inflight = true
  if (oneShot) {
    processedOnce = true
  }
  if (bot.entity?.position) {
    logPrefix(`capture pos=${bot.entity.position.toString()} yaw=${bot.entity.yaw?.toFixed(2)} pitch=${bot.entity.pitch?.toFixed(2)}`)
  }
  const dir = path.dirname(framePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(framePath, frame)
  logPrefix(`saved frame to ${framePath}`)
  const base64 = frame.toString('base64')
  const messages = []
  if (vlmSystemPrompt) {
    messages.push({ role: 'system', content: vlmSystemPrompt })
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: vlmUserPrompt },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
    ]
  })

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), vlmTimeoutMs)
  try {
    const response = await fetch(vlmEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: vlmModel,
        messages,
        temperature: vlmTemperature,
        max_tokens: vlmMaxTokens
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`VLM error ${response.status}: ${text}`)
    }

    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    if (content) {
      logPrefix(`model output: ${content}`)
    } else {
      logPrefix(`model response missing content: ${JSON.stringify(data)}`)
    }
  } finally {
    clearTimeout(timeoutId)
    inflight = false
    lastSentAt = Date.now()
    if (oneShot) {
      logPrefix('one-shot complete, shutting down')
      bot.end()
      setTimeout(() => process.exit(0), 250)
      return
    }
    if (pendingFrame) {
      queueFrame(pendingFrame)
    }
  }
}

function startFrameServer () {
  const server = net.createServer((socket) => {
    logPrefix('viewer connected')
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0)
        if (buffer.length < 4 + size) break
        const frame = buffer.subarray(4, 4 + size)
        buffer = buffer.subarray(4 + size)
        queueFrame(frame)
      }
    })

    socket.on('close', () => {
      logPrefix('viewer disconnected')
    })

    socket.on('error', (err) => {
      logPrefix(`viewer socket error: ${err.message}`)
    })
  })

  server.listen(framePort, frameHost, () => {
    logPrefix(`frame server listening on ${frameHost}:${framePort}`)
  })

  return server
}

const timeout = setTimeout(() => {
  console.error(`[mineflayer-bot] Timed out waiting for spawn after ${connectTimeoutMs}ms`)
  bot.end()
  process.exit(1)
}, connectTimeoutMs)

bot.once('spawn', () => {
  clearTimeout(timeout)
  logPrefix('spawned, preparing headless prismarine-viewer')
  ;(async () => {
    captureReadyAt = Number.POSITIVE_INFINITY
    remainingWarmup = warmupFrames
    const game = bot.game || {}
    logPrefix(`game info: minY=${game.minY} height=${game.height} dimension=${game.dimension} worldName=${game.worldName}`)
    if (!sawPosition && bot.entity?.position) {
      sawPosition = true
      const below = bot.blockAt?.(bot.entity.position.offset(0, -1, 0))
      logPrefix(`spawn pos=${bot.entity.position.toString()} block_below=${below?.name || 'unknown'}`)
      if (!manualCapture) {
        armCapture('spawn')
      }
    }
    try {
      await bot.waitForChunksToLoad()
      logPrefix('chunks loaded')
      const currentPos = bot.entity?.position
      if (currentPos) {
        const below = bot.blockAt?.(currentPos.offset(0, -1, 0))
        logPrefix(`post-load block_below=${below?.name || 'unknown'} stateId=${below?.stateId ?? 'n/a'}`)
      }
    } catch (err) {
      logPrefix(`waitForChunksToLoad failed: ${err.message}`)
    }
    const desiredYaw = degToRad(lookYawDeg)
    const desiredPitch = degToRad(lookPitchDeg)
    tryLook(desiredYaw, desiredPitch)
    const yawOffset = desiredYaw - (bot.entity?.yaw || 0)
    const pitchOffset = desiredPitch - (bot.entity?.pitch || 0)
    mineflayerViewer(bot, {
      output: `${frameHost}:${framePort}`,
      frames: -1,
      width: frameWidth,
      height: frameHeight,
      viewDistance,
      yawOffset,
      pitchOffset,
      jpegOptions: {
        quality: frameQuality,
        progressive: false
      }
    })
    if (moveForwardMs > 0) {
      setTimeout(() => {
        tryMoveForward(moveForwardMs)
      }, 500)
    }
    if (!manualCapture) {
      armCapture('chunks loaded')
    }
    setTimeout(() => {
      if (!sawPosition && !manualCapture) {
        armCapture('ready timeout')
      }
    }, waitForChunksTimeoutMs)
  })().catch((err) => {
    logPrefix(`spawn init failed: ${err.message}`)
  })
})

bot.on('end', (reason) => {
  if (reason) {
    logPrefix(`bot disconnected: ${reason}`)
  } else {
    logPrefix('bot disconnected')
  }
  if (rosReady) {
    try {
      rclnodejs.shutdown()
    } catch (err) {
      logPrefix(`ROS2 shutdown error: ${err.message}`)
    }
  }
  process.exit(0)
})

bot.on('kicked', (reason, loggedIn) => {
  const details = typeof reason === 'string' ? reason : JSON.stringify(reason)
  logPrefix(`bot kicked${loggedIn ? ' after login' : ''}: ${details}`)
})

bot.on('error', (err) => {
  clearTimeout(timeout)
  logPrefix(`bot error: ${err.message}`)
  process.exit(1)
})

initRos2().catch((err) => {
  logPrefix(`ROS2 init error: ${err.message}`)
})
startFrameServer()
startControlLoop()
