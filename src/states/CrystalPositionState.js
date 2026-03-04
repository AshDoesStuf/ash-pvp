const { BaseState } = require("../PvPStateMachine");
const { calculate3DDistance } = require("../utils/utils");

class CrystalPositionState extends BaseState {
  #strafeDir = "left";
  #lastStrafe = 0;
  #nextStrafeDur = 1200;

  async onEnter() {
    this.#strafeDir = Math.random() < 0.5 ? "left" : "right"; // random start dir
    this.#lastStrafe = Date.now();
    this.#nextStrafeDur = this.#getStrafeDur();
    this.bot.clearControlStates();
  }

  async tick() {
    const { bot, ashPvP } = this;
    const target = ashPvP.target;
    if (!target) return "IDLE";

    const dist = calculate3DDistance(bot.entity.position, target.position);
    if (dist > ashPvP.options.crystalDistance + 2) return "PATHING";

    const crystal = ashPvP.crystalPvP;
    const best = crystal.findBestCrystalNearTarget(target);
    if (best && best.targetDamage > 0) return "CRYSTAL_DETONATE";

    const obi = crystal.findGoodObi();
    if (obi && crystal.hasEndCrystals()) return "CRYSTAL_PLACE";

    const obiPlacement = crystal.findGoodObsidianPlacement();
    if (obiPlacement && crystal.hasObsidian()) return "CRYSTAL_PLACE";

    this.#reposition(bot, dist);
    return null;
  }

  async onExit() {
    this.bot.clearControlStates();
  }

  #getStrafeDur() {
    return this.ashPvP.profile?.strafeDurMs() ?? 1200;
  }

  #reposition(bot, dist) {
    const p = this.ashPvP.profile;
    const min = p?.idealMinDist ?? 2.5;
    const max = p?.idealMaxDist ?? 4.0;
    const now = Date.now();

    if (dist < min) {
      bot.setControlState("back", true);
      bot.setControlState("forward", false);
      bot.setControlState("sprint", false);
    } else if (dist > max) {
      bot.setControlState("forward", true);
      bot.setControlState("back", false);
      bot.setControlState("sprint", true);
    } else {
      bot.setControlState("forward", false);
      bot.setControlState("back", false);
      bot.setControlState("sprint", false);
    }

    // Re-roll strafe duration each cycle so timing is profile-dependent
    if (now - this.#lastStrafe > this.#nextStrafeDur) {
      this.#strafeDir = this.#strafeDir === "left" ? "right" : "left";
      this.#lastStrafe = now;
      this.#nextStrafeDur = this.#getStrafeDur(); // chaotic re-rolls every time
    }

    bot.setControlState("left", this.#strafeDir === "left");
    bot.setControlState("right", this.#strafeDir === "right");
  }
}

module.exports = CrystalPositionState;
