// REWRITTEN — evasion runs every tick while eat animation plays
const { BaseState } = require("../PvPStateMachine");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How often we randomly flip strafe direction (ms)
const STRAFE_FLIP_INTERVAL_MS = 500;
// How long to keep running after the eat finishes before re-engaging (ms).
// Regen II ticks every ~1.25s, so 2.5s gets us ~2 extra hearts for free.
const POST_EAT_FLEE_MS = 2500;

class EatingState extends BaseState {
  #done = false;
  #eatFinishedAt = null; // timestamp when eat completed, null while eating
  #strafeDir = 1; // 1 = right, -1 = left
  #strafeTimer = 0; // accumulated ms since last flip

  async onEnter() {
    this.#done = false;
    this.#strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.#strafeTimer = 0;
    this.bot.clearControlStates();

    // Fire eat in the background — tick() handles movement the whole time
    this.#eat()
      .catch((err) => console.error("[EatingState] Eat failed:", err.message))
      .finally(() => {
        // Don't RESUME immediately — start the post-eat flee window first
        this.#eatFinishedAt = Date.now();
      });
  }

  async tick(dt) {
    // Still eating — run evasion
    if (this.#eatFinishedAt === null) {
      this.#evade(dt);
      return null;
    }

    // Eat finished — keep fleeing until POST_EAT_FLEE_MS has elapsed.
    // This lets Regen II tick a few more times before we re-engage.
    // If health is already high enough, cut the window short.
    const { bot } = this;
    const elapsed = Date.now() - this.#eatFinishedAt;
    const healthyEnough = bot.health >= 18;

    if (elapsed < POST_EAT_FLEE_MS && !healthyEnough) {
      this.#evade(dt);
      return null;
    }

    return "RESUME";
  }

  async onExit() {
    this.#done = false;
    this.#eatFinishedAt = null;
    this.bot.clearControlStates();
  }

  // ---------------------------------------------------------------------------
  // Evasion — called every tick while the eat animation is playing
  // ---------------------------------------------------------------------------
  #evade(dt) {
    const { bot, ashPvP } = this;
    const target = ashPvP?.target;

    // Flip strafe direction on a random-ish timer so movement is unpredictable
    this.#strafeTimer += dt * 1000;
    if (this.#strafeTimer >= STRAFE_FLIP_INTERVAL_MS) {
      this.#strafeDir = Math.random() < 0.5 ? 1 : -1;
      this.#strafeTimer = 0;
    }

    if (target) {
      // Face away from target
      const dx = bot.entity.position.x - target.position.x;
      const dz = bot.entity.position.z - target.position.z;
      bot.look(Math.atan2(-dx, -dz), 0, true);
    }

    // Strafe
    if (this.#strafeDir === 1) {
      bot.setControlState("right", true);
      bot.setControlState("left", false);
    } else {
      bot.setControlState("left", true);
      bot.setControlState("right", false);
    }

    if (target) {
      bot.setControlState("forward", true);
      bot.setControlState("sprint", true);
      bot.setControlState("jump", true);
    }

    // Jump over anything we walk into
    if (bot.entity.isCollidedHorizontally) {
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 150);
    }
  }

  // ---------------------------------------------------------------------------
  // Eat — fires in the background, never blocks tick()
  // ---------------------------------------------------------------------------
  async #eat() {
    const { bot, ashPvP } = this;
    const awareness = ashPvP?.awareness;

    // Use awareness to pick the right gap — saves notch apples for emergencies
    const isEmergency = bot.health <= 6 || (awareness?.incomingDPS ?? 0) > 4;
    const gap = awareness
      ? awareness.selectGap(bot, isEmergency)
      : bot.inventory.slots.find((i) => i?.name?.includes("golden_apple"));

    if (!gap) return;

    const offhandSlot = bot.getEquipmentDestSlot("off-hand");
    const currentOffhand = bot.inventory.slots[offhandSlot];
    const inOffhand = currentOffhand?.name === gap.name;

    bot.autoEat?.disable();

    try {
      if (!inOffhand) await bot.equip(gap, "off-hand");
      bot.activateItem(true);
      await sleep(1601);
      bot.deactivateItem(true);
      // Notify awareness so it can track regen/absorption windows
      awareness?.notifyGapConsumed();
    } finally {
      bot.autoEat?.enable();
    }
  }
}

module.exports = EatingState;
