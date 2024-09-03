const AshPvP = require("./pvp");

function inject(bot) {
  bot.ashpvp = new AshPvP(bot);
}

module.exports = inject 
