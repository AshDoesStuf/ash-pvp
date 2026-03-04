const { BaseState } = require("../PvPStateMachine");

// If the pearl lands and we survive, we want to immediately re-engage or idle.
// If it fails entirely we fall back to RESUME so the FSM can decide what's next.
class PearlingState extends BaseState {
  #done = false;
  #pearled = false; // true = teleport confirmed, false = threw but no confirm yet

  async onEnter() {
    this.#done = false;
    this.#pearled = false;
    this.bot.clearControlStates();

    // Fire pearl in background — tick() keeps running so we sprint away
    // while the pearl is in the air. If the bot teleports, forcedMove fires
    // and pearlAway resolves; tick then sees #done and returns RESUME.
    this.ashPvP
      .pearlAway()
      .then((success) => {
        this.#pearled = success;
      })
      .catch((err) => console.error("[PearlingState] pearlAway threw:", err))
      .finally(() => {
        this.#done = true;
      });
  }

  async tick(dt) {
    if (this.#done) return "RESUME";

    // While the pearl is in the air: sprint away from target.
    // This gives us free distance even if the pearl misses or times out.
    this.#fleeMovement();

    return null;
  }

  async onExit() {
    this.#done = false;
    this.#pearled = false;
    this.bot.clearControlStates();
  }

  // ---------------------------------------------------------------------------
  // Sprint directly away from the target while the pearl is in the air.
  // Simple and effective — if the pearl lands great, if not we at least bought
  // a few blocks of distance on foot.
  // ---------------------------------------------------------------------------
  #fleeMovement() {
    const { bot, ashPvP } = this;
    const target = ashPvP?.target;

    if (target) {
      // Face away from target
      const dx = bot.entity.position.x - target.position.x;
      const dz = bot.entity.position.z - target.position.z;
      bot.look(Math.atan2(-dx, -dz), 0, true);
    }

    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);

    // Jump over any obstacles while sprinting
    if (
      bot.entity.isCollidedHorizontally ||
      (bot.entity.onGround && Math.random() < 0.05)
    ) {
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 150);
    }
  }
}

module.exports = PearlingState;
