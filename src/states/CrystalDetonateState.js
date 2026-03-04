const { BaseState } = require("../PvPStateMachine");

class CrystalDetonateState extends BaseState {
  async onEnter() {
    this.bot.clearControlStates();
  }

  async tick() {
    const { ashPvP } = this;
    const target = ashPvP.target;
    if (!target) return "IDLE";

    const crystal = ashPvP.crystalPvP;
    const best = crystal.findBestCrystalNearTarget(target);

    if (!best) return "CRYSTAL_POSITION";

    await crystal.hitThenDetonate(best.crystal, target);

    // Always retreat after detonating — duration/distance is profile-driven
    return "RETREATING";
  }

  async onExit() {
    this.bot.clearControlStates();
  }
}

module.exports = CrystalDetonateState;
