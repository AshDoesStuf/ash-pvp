const { BaseState } = require("../PvPStateMachine");
const aStar = require("../smart");
const Vec3 = require("vec3").Vec3;
const { calculate3DDistance } = require("../utils/utils");

// How far the target must move before we recompute the path
const RECOMPUTE_THRESHOLD = 2.5;
// Min ms between path recomputes (avoids thrashing A* every tick)
const RECOMPUTE_COOLDOWN_MS = 400;

// Sprint-jump rhythm: hold jump for ~250ms then release for ~100ms.
// Matches Minecraft's optimal bunny-hop cadence (~30% faster than flat sprint).
// Only active on flat ground segments — waypoint climbs use normal jump logic.
const SPRINT_JUMP_HOLD_MS = 250;
const SPRINT_JUMP_RELEASE_MS = 100;

class PathingState extends BaseState {
  #path = [];
  #pathIdx = 0;
  #lastTargetPos = null;
  #lastRecomputeAt = 0;
  #computing = false;

  // Sprint-jump oscillator state
  #sjPhase = "hold"; // "hold" | "release"
  #sjTimer = 0; // ms spent in current phase

  async onEnter() {
    this.#path = [];
    this.#pathIdx = 0;
    this.#lastTargetPos = null;
    this.#lastRecomputeAt = 0;
    this.#computing = false;
    this.#sjPhase = "hold";
    this.#sjTimer = 0;
    this.bot.clearControlStates();
  }

  async tick(dt) {
    const { bot, ashPvP } = this;
    const target = ashPvP.target;
    if (!target) return "IDLE";

    const myPos = bot.entity.position;
    const targetPos = target.position;
    const dist = calculate3DDistance(myPos, targetPos);

    // --- Transition checks (run every tick, not gated by walk loop) ---
    if (dist <= ashPvP.options.crystalDistance && ashPvP.options.crystalPvP)
      return "CRYSTAL_POSITION";
    if (
      dist <= ashPvP.options.maxAttackDist + 2.5 &&
      !ashPvP.options.crystalPvP
    )
      return "MELEE_ENGAGE";

    // --- Decide if we need a fresh path ---
    const now = Date.now();
    const targetMoved =
      this.#lastTargetPos &&
      this.#lastTargetPos.distanceTo(targetPos) > RECOMPUTE_THRESHOLD;
    const pathExhausted = this.#pathIdx >= this.#path.length;
    const cooldownOk = now - this.#lastRecomputeAt > RECOMPUTE_COOLDOWN_MS;

    if (
      !this.#computing &&
      cooldownOk &&
      (pathExhausted || targetMoved || !this.#path.length)
    ) {
      this.#computing = true;
      this.#lastRecomputeAt = now;
      this.#computePath(target).finally(() => {
        this.#computing = false;
      });
    }

    // --- Step toward current waypoint ---
    this.#stepMovement(myPos, targetPos, dt);

    return null;
  }

  async onExit() {
    this.bot.clearControlStates();
    this.#path = [];
    this.#computing = false;
  }

  // ---------------------------------------------------------------------------
  // Non-blocking single-step movement toward the next waypoint.
  // ---------------------------------------------------------------------------
  #stepMovement(myPos, targetPos, dt) {
    const { bot } = this;

    if (!this.#path.length || this.#pathIdx >= this.#path.length) {
      this.#faceAndWalk(bot, targetPos, dt);
      return;
    }

    const wp = this.#path[this.#pathIdx];
    const distToWp = myPos.distanceTo(wp);
    const dy = wp.y - myPos.y;
    const isClimbing = dy > 0.3; // waypoint is meaningfully above us
    const isDropping = dy < -0.5; // waypoint is below (falling)

    // Look toward the node AHEAD of current when we're close — keeps movement
    // smooth and avoids the bot snapping left/right at each waypoint
    const lookTarget = this.#getLookAheadWp(myPos);
    const ldx = lookTarget.x - myPos.x;
    const ldz = lookTarget.z - myPos.z;
    bot.look(Math.atan2(-ldx, -ldz), 0, true);

    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);

    if (isClimbing || bot.entity.isCollidedHorizontally) {
      // Obstacle or step-up — hard jump, reset oscillator so we re-sync on landing
      this.#sjPhase = "hold";
      this.#sjTimer = 0;
      bot.setControlState("jump", true);
    } else if (isDropping || !bot.entity.onGround) {
      // Falling — don't touch jump, let gravity handle it
      bot.setControlState("jump", false);
    } else {
      // Flat/shallow ground — run the sprint-jump oscillator for max speed
      this.#tickSprintJump(bot, dt);
    }

    // Dynamic acceptance radius — scales with current horizontal speed so a
    // fast sprint-jump never overshoots a node and forces a backtrack.
    // Also skip forward immediately if the NEXT waypoint is already closer
    // (means we flew past the current one mid-jump).
    const speed = Math.sqrt(
      bot.entity.velocity.x ** 2 + bot.entity.velocity.z ** 2,
    );
    const acceptRadius = Math.max(0.7, speed * 2.5);

    if (distToWp < acceptRadius || this.#nextWpIsCloser(myPos)) {
      this.#pathIdx++;
      this.#sjPhase = "hold";
      this.#sjTimer = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Sprint-jump oscillator.
  // Advances the hold→release→hold cycle each tick using real delta time.
  // ---------------------------------------------------------------------------
  #tickSprintJump(bot, dt) {
    this.#sjTimer += (dt ?? 0.05) * 1000; // dt is in seconds

    if (this.#sjPhase === "hold") {
      bot.setControlState("jump", true);
      if (this.#sjTimer >= SPRINT_JUMP_HOLD_MS) {
        this.#sjPhase = "release";
        this.#sjTimer = 0;
      }
    } else {
      bot.setControlState("jump", false);
      if (this.#sjTimer >= SPRINT_JUMP_RELEASE_MS) {
        this.#sjPhase = "hold";
        this.#sjTimer = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Fallback when no path exists — face target and sprint-jump blindly.
  // ---------------------------------------------------------------------------
  #faceAndWalk(bot, targetPos, dt) {
    const dx = targetPos.x - bot.entity.position.x;
    const dz = targetPos.z - bot.entity.position.z;
    bot.look(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);

    if (bot.entity.isCollidedHorizontally) {
      // Hard obstacle — override oscillator with a full jump
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 150);
    } else if (bot.entity.onGround) {
      this.#tickSprintJump(bot, dt);
    }
  }

  // ---------------------------------------------------------------------------
  // Look-ahead helper — returns the waypoint 1-2 nodes ahead when close to
  // current, so the bot steers toward where it's going rather than the node
  // it's about to pass through. Prevents the zigzag head-snap at each node.
  // ---------------------------------------------------------------------------
  #getLookAheadWp(myPos) {
    const path = this.#path;
    const len = path.length;
    if (!len || this.#pathIdx >= len) return myPos; // no path, look at self (no-op)

    const cur = path[this.#pathIdx];
    const distToCur = myPos.distanceTo(cur);

    // If we're within 2 blocks of current wp, aim at the one after it
    if (distToCur < 2.0 && this.#pathIdx + 1 < len) {
      return path[this.#pathIdx + 1];
    }
    return cur;
  }

  // Returns true if the NEXT waypoint is closer than the current one —
  // meaning we've already flown past the current node mid-jump.
  #nextWpIsCloser(myPos) {
    const path = this.#path;
    const nextIdx = this.#pathIdx + 1;
    if (nextIdx >= path.length) return false;

    const distCur = myPos.distanceTo(path[this.#pathIdx]);
    const distNext = myPos.distanceTo(path[nextIdx]);
    return distNext < distCur;
  }

  // ---------------------------------------------------------------------------
  // Path computation — async but non-blocking to tick()
  // ---------------------------------------------------------------------------
  async #computePath(target) {
    const { bot, ashPvP } = this;

    let ground = target.position.offset(0, -1, 0);
    let block = bot.blockAt(ground);
    for (let i = 0; i < 5 && block?.boundingBox !== "block"; i++) {
      ground = ground.offset(0, -1, 0);
      block = bot.blockAt(ground);
    }

    const path = aStar(bot, bot.entity.position, ground.offset(0, 1, 0), {
      stopDistance: ashPvP.options.maxFollowRange,
      smooth: true,
    });

    if (path && path.length) {
      this.#path = path;
      this.#pathIdx = 0;
    }

    this.#lastTargetPos = target.position.clone();
  }
}

module.exports = PathingState;
