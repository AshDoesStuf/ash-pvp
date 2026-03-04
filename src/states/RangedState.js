const { BaseState } = require("../PvPStateMachine");
const { calculate3DDistance } = require("../utils/utils");

class RangedState extends BaseState {
  async onEnter() {
    this.bot.clearControlStates();
  }

  async tick() {
    const { ashPvP } = this;
    const target = ashPvP.target;
    if (!target) return "IDLE";

    const dist = calculate3DDistance(this.bot.entity.position, target.position);

    // Hand off to melee if they close the gap
    if (dist <= ashPvP.options.maxAttackDist) return "MELEE_ENGAGE";

    await ashPvP.rangedAttack();
    return null;
  }

  async onExit() {
    this.bot.clearControlStates();
  }
}

module.exports = RangedState;
