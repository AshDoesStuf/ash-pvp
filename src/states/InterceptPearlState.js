const { BaseState } = require("../PvPStateMachine");
const Vec3 = require("vec3").Vec3;

// Min health to be "healthy enough" to aggress with a pearl
const MIN_HEALTH_TO_INTERCEPT = 14;
// Target must be moving away at least this fast (blocks/tick) to qualify
const MIN_FLEE_SPEED = 0.15;
// Target must be at least this far for a pearl to be worth it
const MIN_INTERCEPT_DIST = 8;
// ...and no further than this (pearl range limit)
const MAX_INTERCEPT_DIST = 18;
// Cooldown between intercept attempts so we don't burn all pearls (ms)
const INTERCEPT_COOLDOWN_MS = 12000;
// Approximate pearl flight time to landing (ms) — used for intercept prediction
const PEARL_FLIGHT_MS = 1400;

let lastInterceptAt = 0; // module-level so it persists across state re-entries

class InterceptPearlState extends BaseState {
  #done = false;
  #success = false;

  async onEnter() {
    this.#done = false;
    this.#success = false;
    this.bot.clearControlStates();

    this.#throwIntercept()
      .then((ok) => {
        this.#success = ok;
      })
      .catch((err) => console.error("[InterceptPearlState] threw:", err))
      .finally(() => {
        this.#done = true;
      });
  }

  async tick() {
    if (this.#done) {
      // Whether it worked or not, get back into the fight
      return "PATHING";
    }

    // Sprint toward where we expect to land while pearl is in the air
    this.#chaseMovement();
    return null;
  }

  async onExit() {
    this.#done = false;
    this.bot.clearControlStates();
  }

  // ---------------------------------------------------------------------------
  // Predict where the target will be in PEARL_FLIGHT_MS and throw there.
  // ---------------------------------------------------------------------------
  async #throwIntercept() {
    const { bot, ashPvP } = this;
    const target = ashPvP.target;
    if (!target) return false;

    const pearl = bot.inventory.items().find((i) => i.name === "ender_pearl");
    if (!pearl) return false;

    // Predict target position at time of landing
    const vel = target.velocity;
    const flightSecs = PEARL_FLIGHT_MS / 1000;
    const predicted = target.position.offset(
      vel.x * 20 * flightSecs, // vel is blocks/tick, 20 ticks/sec
      0,
      vel.z * 20 * flightSecs,
    );

    // Find a safe landing spot near the predicted position
    // Scan a small radius around prediction to find solid ground
    const landingPos = this.#findLandingNear(predicted);
    if (!landingPos) return false;

    const shot = bot.hawkEye.getMasterGrade(
      { position: landingPos },
      new Vec3(0, 0.05, 0),
      "ender_pearl",
    );
    if (!shot) return false;

    try {
      await bot.equip(pearl, "hand");
      await bot.look(shot.yaw, shot.pitch, true);
      bot.activateItem(false);

      await Promise.race([
        new Promise((r) => bot.once("forcedMove", r)),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 3000),
        ),
      ]);

      lastInterceptAt = Date.now();
      return true;
    } catch (err) {
      console.warn("[InterceptPearlState] throw failed:", err.message);
      return false;
    }
  }

  #findLandingNear(pos) {
    const { bot } = this;
    // Search expanding rings around predicted position for a safe 2-high gap
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // ring only
          for (let dy = 1; dy >= -3; dy--) {
            const ground = bot.blockAt(
              new Vec3(
                Math.floor(pos.x + dx),
                Math.floor(pos.y + dy - 1),
                Math.floor(pos.z + dz),
              ),
            );
            const foot = bot.blockAt(
              new Vec3(
                Math.floor(pos.x + dx),
                Math.floor(pos.y + dy),
                Math.floor(pos.z + dz),
              ),
            );
            const head = bot.blockAt(
              new Vec3(
                Math.floor(pos.x + dx),
                Math.floor(pos.y + dy + 1),
                Math.floor(pos.z + dz),
              ),
            );
            if (!ground || !foot || !head) continue;
            if (
              ground.boundingBox === "block" &&
              foot.boundingBox === "empty" &&
              head.boundingBox === "empty" &&
              !ground.name.includes("lava") &&
              !foot.name.includes("lava") &&
              !foot.name.includes("fire")
            ) {
              return foot.position;
            }
          }
        }
      }
    }
    return null;
  }

  // Sprint toward the predicted landing zone while in the air
  #chaseMovement() {
    const { bot, ashPvP } = this;
    const target = ashPvP.target;
    if (!target) return;

    const dx = target.position.x - bot.entity.position.x;
    const dz = target.position.z - bot.entity.position.z;
    bot.look(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
  }

  // ---------------------------------------------------------------------------
  // Static eligibility check — called from MeleeEngageState each tick
  // ---------------------------------------------------------------------------
  static shouldIntercept(bot, ashPvP) {
    if (Date.now() - lastInterceptAt < INTERCEPT_COOLDOWN_MS) return false;
    if (bot.health < MIN_HEALTH_TO_INTERCEPT) return false;

    const pearl = bot.inventory.items().find((i) => i.name === "ender_pearl");
    if (!pearl) return false;

    const target = ashPvP.target;
    if (!target) return false;

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist < MIN_INTERCEPT_DIST || dist > MAX_INTERCEPT_DIST) return false;

    // Target must be actively fleeing (moving away from us)
    const toTarget = target.position.minus(bot.entity.position);
    const len = Math.sqrt(toTarget.x ** 2 + toTarget.z ** 2) || 1;
    const nx = toTarget.x / len,
      nz = toTarget.z / len;
    const fleeSpeed = target.velocity.x * nx + target.velocity.z * nz;

    return fleeSpeed > MIN_FLEE_SPEED;
  }
}

module.exports = InterceptPearlState;
