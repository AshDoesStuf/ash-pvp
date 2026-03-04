const { BaseState } = require("../PvPStateMachine");
const InterceptPearlState = require("./InterceptPearlState");
const { calculate3DDistance, getRandomInRange } = require("../utils/utils");
const Vec3 = require("vec3").Vec3;

// How long after a hit we wait before reading knockback and repositioning
const KNOCKBACK_SETTLE_MS = 380;

// Gaussian jitter for attack timing — makes two bots desync naturally
function gaussianJitter(stddev = 25) {
  // Box-Muller transform
  const u1 = Math.random(),
    u2 = Math.random();
  return stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

class MeleeEngageState extends BaseState {
  // Cooldown tracking
  #lastAttackTime = 0;
  #attackJitter = 0; // ms offset applied to this swing's cooldown

  // Knockback state
  #waitingForKnockback = false;
  #knockbackTarget = null; // predicted target position post-knockback
  #knockbackResolveAt = 0;

  // Approach tracking — used for juke decision
  #lastTargetPos = null;
  #targetApproachV = 0; // positive = target moving toward us, negative = away

  // Raw pursuit burst — chase directly before handing to PATHING
  #pursuitBurstMs = 0;
  static #PURSUIT_BURST_DURATION = 600; // ms of raw chase before giving up to A*

  async onEnter() {
    this.#lastAttackTime = 0;
    this.#attackJitter = gaussianJitter();
    this.#waitingForKnockback = false;
    this.#knockbackTarget = null;
    this.#lastTargetPos = null;
    this.#targetApproachV = 0;
    this.#pursuitBurstMs = 0;
    this.bot.clearControlStates();
  }

  async tick(dt) {
    const { bot, ashPvP } = this;
    const target = ashPvP.target;
    if (!target) return "IDLE";

    const botPos = bot.entity.position;
    const targetPos = target.position;
    const dist = calculate3DDistance(botPos, targetPos);

    // Check intercept-pearl opportunity before anything else
    if (InterceptPearlState.shouldIntercept(bot, ashPvP))
      return "INTERCEPT_PEARL";

    // Target escaped melee range — do a short raw pursuit burst before handing
    // to A* pathfinding. If they're only a few blocks away this closes the gap
    // faster than waiting for a path to compute.
    if (dist > ashPvP.options.maxAttackDist + 2.5) {
      if (this.#pursuitBurstMs < MeleeEngageState.#PURSUIT_BURST_DURATION) {
        this.#pursuitBurstMs += dt * 1000;
        this.#doPursuitBurst(bot, targetPos);
        return null;
      }
      this.#pursuitBurstMs = 0;
      return "PATHING";
    }
    // Back in range — reset burst timer
    this.#pursuitBurstMs = 0;

    // Update target approach velocity (positive = closing in on us)
    this.#updateApproachVelocity(botPos, target);

    // Tick attack timer
    this.#lastAttackTime += dt * 1000;

    // If we're waiting for knockback to resolve, handle repositioning
    if (this.#waitingForKnockback) {
      this.#handleKnockbackReposition(botPos);
      return null;
    }

    // Movement
    this.#handleMovement(bot, dist, botPos, targetPos);

    // Attack
    this.#tryAttack(bot, target, dist);

    return null;
  }

  async onExit() {
    this.bot.clearControlStates();
    this.#waitingForKnockback = false;
  }

  // ---------------------------------------------------------------------------
  // Movement
  // ---------------------------------------------------------------------------

  #handleMovement(bot, dist, botPos, targetPos) {
    const { ashPvP } = this;
    const min = ashPvP.options.minAttackDist;
    const max = ashPvP.options.maxAttackDist;

    // Always look at target
    const dx = targetPos.x - bot.entity.position.x;
    const dz = targetPos.z - bot.entity.position.z;
    const yaw = Math.atan2(-dx, -dz);

    bot.look(yaw, 0, true);

    bot.setControlState("right", false);
    bot.setControlState("left", false);

    // Collision jump
    if (bot.entity.isCollidedHorizontally) {
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 200);
    }

    // Too far — close the gap
    if (dist > max) {
      bot.setControlState("forward", true);
      bot.setControlState("sprint", true);
      bot.setControlState("jump", true);
      bot.setControlState("back", false);
      bot.setControlState("right", false);
      bot.setControlState("left", false);
      return;
    }

    // In the sweet spot — juke based on target approach velocity
    if (dist >= min && dist <= max) {
      bot.setControlState("sprint", true);
      bot.setControlState("jump", false);

      if (Math.random() <= 0.5) {
        bot.setControlState("left", true);
        bot.setControlState("right", false);
      } else {
        bot.setControlState("right", true);
        bot.setControlState("left", false);
      }

      // Target closing in on us → s-tap (step back, bait the overshoot)
      // Target retreating or stationary → w-tap (push the advantage)
      if (this.#targetApproachV > 0.05) {
        this.#doStap(bot, dist);
      } else {
        bot.setControlState("forward", true);
        bot.setControlState("back", false);
      }
      return;
    }

    // Too close — back off to attack range
    if (dist < min) {
      bot.setControlState("back", true);
      bot.setControlState("forward", false);
      bot.setControlState("sprint", false);
      bot.setControlState("right", false);
      bot.setControlState("left", false);
    }
  }

  // ---------------------------------------------------------------------------
  // Attack
  // ---------------------------------------------------------------------------

  #tryAttack(bot, target, dist) {
    const { ashPvP } = this;
    const cooldown = ashPvP.heldItemCooldown + this.#attackJitter;

    if (this.#lastAttackTime < cooldown) return;

    // Reach discipline — only swing if:
    // 1. Target is within max reach
    // 2. We have a velocity advantage (closing in or target not running away fast)
    //    — BUT skip the velocity check entirely at point-blank range (< 1.5 blocks).
    //    At that distance the target's relative velocity often reads negative because
    //    they've already passed the closing threshold, which was silently blocking
    //    attacks and letting them get free hits in.
    const reachOk = dist <= ashPvP.options.maxAttackDist;
    const pointBlank = dist < 1.5;
    const velOk = pointBlank || this.#targetApproachV > -0.15;

    if (!reachOk) return;

    // Roll new jitter for next swing
    this.#attackJitter = gaussianJitter();
    this.#lastAttackTime = 0;

    const isCrit =
      ashPvP.isNetherite && Math.random() < ashPvP.options.critChance;

    if (isCrit) {
      this.#doCrit(bot, target, dist);
    } else {
      this.#doSwing(bot, target, dist);
    }
  }

  #doSwing(bot, target, dist) {
    const { ashPvP } = this;

    bot.setControlState("jump", false);
    bot.attack(target);
    ashPvP.emit("hit");

    // Record knockback prediction
    // this.#beginKnockbackRead(bot, target, dist);

    // W-tap if target was moving away (push advantage)
    if (this.#targetApproachV <= 0) {
      this.#doWtap(bot, dist);
    }
  }

  #doCrit(bot, target, dist) {
    const { ashPvP } = this;

    bot.setControlState("forward", false);
    bot.setControlState("sprint", false);
    bot.setControlState("jump", true);

    setTimeout(() => {
      if (!ashPvP.target) return;
      bot.attack(target);
      bot.setControlState("jump", false);
      ashPvP.emit("hit");
      // this.#beginKnockbackRead(bot, target, dist);
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // W-tap / S-tap
  // ---------------------------------------------------------------------------

  #doWtap(bot, dist) {
    // Hold sprint reset longer if target is farther — avoid overshooting
    const holdMs = Math.round(
      30 + (dist / this.ashPvP.options.maxAttackDist) * 40,
    );

    bot.setControlState("sprint", false);
    bot.setControlState("forward", false);

    setTimeout(() => {
      bot.setControlState("sprint", true);
      bot.setControlState("forward", true);
    }, holdMs);
  }

  #doStap(bot, dist) {
    // Step back briefly — duration scales with how aggressively target is closing
    const holdMs = Math.round(20 + this.#targetApproachV * 120);

    bot.setControlState("sprint", false);
    bot.setControlState("forward", false);
    bot.setControlState("back", true);

    setTimeout(
      () => {
        bot.setControlState("sprint", true);
        bot.setControlState("forward", true);
        bot.setControlState("back", false);
      },
      Math.max(20, Math.min(holdMs, 80)),
    );
  }

  // ---------------------------------------------------------------------------
  // Knockback prediction
  // After we land a hit, predict where the target will be once knockback
  // resolves (~380ms), then sprint to that position to be in range for follow-up
  // ---------------------------------------------------------------------------

  #beginKnockbackRead(bot, target, dist) {
    // Knockback direction is roughly away from us
    const botPos = bot.entity.position;
    const targetPos = target.position;

    const dx = targetPos.x - botPos.x;
    const dz = targetPos.z - botPos.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;

    // Minecraft base knockback is ~0.4 blocks/tick for ~5 ticks ≈ 2 blocks
    const kbDist = 2.0;
    this.#knockbackTarget = targetPos.offset(
      (dx / len) * kbDist,
      0,
      (dz / len) * kbDist,
    );

    this.#waitingForKnockback = true;
    this.#knockbackResolveAt = Date.now() + KNOCKBACK_SETTLE_MS;

    bot.setControlState("forward", false);
    bot.setControlState("sprint", false);
  }

  #handleKnockbackReposition(botPos) {
    const bot = this.bot;
    const now = Date.now();

    if (now < this.#knockbackResolveAt) {
      // While waiting — hold position, look toward predicted landing spot
      if (this.#knockbackTarget)
        bot.lookAt(this.#knockbackTarget.offset(0, 1.6, 0), true);
      return;
    }

    // Knockback has resolved — sprint to intercept
    const predicted = this.#knockbackTarget;
    if (!predicted || !this.ashPvP.target) {
      this.#waitingForKnockback = false;
      return;
    }

    const distToPredicted = botPos.distanceTo(predicted);
    if (distToPredicted > this.ashPvP.options.maxAttackDist) {
      bot.setControlState("forward", true);
      bot.setControlState("sprint", true);
    }

    // Close enough — resume normal combat
    if (distToPredicted <= this.ashPvP.options.maxAttackDist + 0.3) {
      this.#waitingForKnockback = false;
      bot.setControlState("forward", false);
      bot.setControlState("sprint", false);
    }
  }

  // ---------------------------------------------------------------------------
  // Raw pursuit burst — sprint-jump directly at target for a short window
  // before handing off to A*. Faster than waiting for path computation when
  // the target is only a few blocks out of range.
  // ---------------------------------------------------------------------------
  #doPursuitBurst(bot, targetPos) {
    const dx = targetPos.x - bot.entity.position.x;
    const dz = targetPos.z - bot.entity.position.z;
    bot.look(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
    if (bot.entity.onGround || bot.entity.isCollidedHorizontally) {
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 150);
    }
  }

  // ---------------------------------------------------------------------------
  // Target approach velocity tracking
  // Positive = target moving toward bot, negative = target moving away
  // ---------------------------------------------------------------------------

  /**
   *
   * @param {Vec3} botPos
   * @param {import("prismarine-entity").Entity} target
   */
  #updateApproachVelocity(botPos, target) {
    const targetPos = target.position;
    const targetVel = target.velocity;
    const botVel = this.bot.entity.velocity;

    const toBot = botPos.minus(targetPos);
    const len = Math.sqrt(toBot.x ** 2 + toBot.z ** 2) || 1;

    const nx = toBot.x / len;
    const nz = toBot.z / len;

    const relVel = {
      x: targetVel.x - botVel.x,
      z: targetVel.z - botVel.z,
    };

    const approachSpeed = relVel.x * nx + relVel.z * nz;

    // Smooth it
    this.#targetApproachV = this.#targetApproachV * 0.6 + approachSpeed * 0.4;
  }
}

module.exports = MeleeEngageState;
