const { BaseState } = require("../PvPStateMachine");

class CrystalPlaceState extends BaseState {
  async onEnter() {
    this.bot.clearControlStates();
  }

  async tick() {
    const { ashPvP } = this;
    const target = ashPvP.target;
    if (!target) return "IDLE";

    const crystal = ashPvP.crystalPvP;

    // Prefer placing a crystal on existing obi — highest value action
    const obi = crystal.findGoodObi();
    if (obi && crystal.hasEndCrystals()) {
      await crystal.placeCrystal(obi, target);
      // After placing, immediately check for detonation opportunity
      return "CRYSTAL_DETONATE";
    }

    // Fall back to placing obsidian to create new obi spots
    const obiPos = crystal.findGoodObsidianPlacement();
    if (obiPos && crystal.hasObsidian()) {
      await crystal.placeObsidian(obiPos);
      // Reposition so we get a fresh angle to place a crystal next tick
      return "CRYSTAL_POSITION";
    }

    // Nothing to place — reposition
    return "CRYSTAL_POSITION";
  }

  async onExit() {
    this.bot.clearControlStates();
  }
}

module.exports = CrystalPlaceState;
