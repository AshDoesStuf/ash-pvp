const { BaseState } = require("../PvPStateMachine");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RetreatingState extends BaseState {
  #done = false;

  async onEnter() {
    this.#done = false;
    const p = this.ashPvP.profile;

    const duration = p?.retreatDurationMs() ?? 500;
    const blocks = p?.retreatBlocks() ?? 2.0;

    this.bot.setControlState("sprint", true);
    this.bot.setControlState("back", true);
    this.bot.setControlState("forward", false);
    this.bot.setControlState("jump", false);

    // Optionally strafe randomly while retreating to be less predictable
    const strafeDir = Math.random() < 0.5 ? "left" : "right";
    this.bot.setControlState(strafeDir, true);

    try {
      await sleep(duration);
    } finally {
      this.bot.clearControlStates();
      this.#done = true;
    }
  }

  async tick() {
    if (!this.ashPvP.target) return "IDLE";
    if (this.#done) return "CRYSTAL_POSITION";
    return null;
  }

  async onExit() {
    this.bot.clearControlStates();
    this.#done = false;
  }
}

module.exports = RetreatingState;
