const { pathfinder, Movements } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const mcDataLoader = require('minecraft-data')

function findLogBlocks (bot, maxDistance, maxCount) {
  return bot.findBlocks({
    matching: (block) => block && /(_log|_stem|_hyphae)$/.test(block.name),
    maxDistance,
    count: maxCount
  })
}

module.exports = function gatherWoodPlugin (bot) {
  const mcData = mcDataLoader(bot.version)
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlock)

  async function gatherWood (count = 16, options = {}) {
    const maxDistance = options.maxDistance ?? 64
    const maxCount = options.maxCount ?? 10

    const movements = new Movements(bot, mcData)
    bot.pathfinder.setMovements(movements)

    const logPositions = findLogBlocks(bot, maxDistance, maxCount)
    if (logPositions.length === 0) {
      throw new Error('No logs nearby')
    }

    const targets = logPositions.map((pos) => bot.blockAt(pos)).filter(Boolean)
    await bot.collectBlock.collect(targets, { count })

    const logs = bot.inventory.items().filter((item) => /(_log|_stem|_hyphae)$/.test(item.name))
    return logs.reduce((sum, item) => sum + item.count, 0)
  }

  bot.behaviors = bot.behaviors || {}
  bot.behaviors.gatherWood = gatherWood
}
