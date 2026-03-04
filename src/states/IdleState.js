const { BaseState } = require("../PvPStateMachine");

class IdleState extends BaseState {
  async onEnter() {
    this.bot.clearControlStates();
  }

  async tick() {
    if (this.ashPvP.target) return "PATHING";
    return null;
  }

  async onExit() {}
}

module.exports = IdleState;
