const Entity = require("prismarine-entity").Entity;
const Vec3 = require("vec3").Vec3;

const EventEmitter = require("events");

const armorMap = require("./utils/armorMap.json");
const armorPointsMap = require("./utils/armorPoints.json");
const weaponBase = require("./utils/weaponBase.json");
const offhandPriority = require("./utils/offhandPriority.json");

const astar = require("./smart.js");

const sleep = (ms = 2000) => {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
};

const {
  calculateDistanceInBox,
  getSpeed,
  between,
  getItemEnchantments,
  getRandomInRange,
  placeBlock,
  calculate3DDistance,
} = require("./utils/utils.js");
const { GoalNear } = require("../../mineflayer-baritone/src/goal.js");
const aStar = require("./smart.js");
const { Weapons } = require("minecrafthawkeye");

class AshPvP extends EventEmitter {
  /**
   * @type {import("mineflayer").Bot}
   */
  #bot;

  #wtapping = false;

  #stapping = false;

  #clostToTarget = false;

  #eatingGap = false;

  #canUpdateMainHand = true;

  #canUpdateOffhand = true;

  #critting = false;

  #attackTask = null;

  #lastGapEatTime = 0;
  #gapCooldownMs = 3000;
  #gapEatCount = 0;

  #debugEatGap = false;

  /**
   * @type {string}
   */
  #lastSelectedOffhand = null;

  #pathingState = false;

  constructor(bot) {
    super();
    /**
     * @type {import("mineflayer").Bot}
     */
    this.#bot = bot;
    this.running = false;
    this.lastUpdate = performance.now();
    this.paused = false;
    this.combatEnabled = false;

    this.options = {
      /**
       * The minimum attack distance/reach
       */
      minAttackDist: 2,
      /**
       * The maximum attack distance/reach
       */
      maxAttackDist: 2.8,
      /**
       * The max range for following untill we can use pathfinder
       */
      maxFollowRange: 15,
      /**
       * The interval at which we switch targets in ffa
       */
      targetSwitchInterval: 3500,

      /**
       * Chance to do a crit
       */
      critChance: 0,

      /**
       *
       */
      placeCooldown: 6700,

      /**
       * Crystal pvp
       */
      crystalPvP: true,

      /**
       * Distance we can crystal at
       */
      crystalDistance: 4,

      /**
       * Only use ranged attacks
       */
      bowPvP: false,
    };

    /**
     * The target we are currently attack. This is set by attack
     *
     * @type {Entity | null}
     */
    this.target = null;
    this.lastAttackTime = 0;
    this.lastPlaceTime = 0;
    this.isAttacking = false;
    this.ffaToggle = false;

    this.strafeDuration = 3400;
    this.lastStrafeChangeTime = Date.now();
    this.currentStrafeDirection = "left";

    this.lastWTtapTime = 0;
    this.targetAcquiredAt = 0;

    this.heldItemCooldown = this.calculateHeldItemCooldown();

    // this.updateTick = this.updateTick.bind(this);
    this.stop = this.stop.bind(this);

    this.teamates = [];

    /**
     * @type {Set<number>}
     */
    this.possibleTargets = new Set();

    this.lastPath = []; // Store last computed path
    this.pathIndex = 0; // Keep track of path progress
    this.lastAStarTime = 0; // Cooldown timer
    this.recalculateThreshold = 2;

    this.isPathing = false;
    this.isPearling = false;
    this.canBowTarget = false;

    this.trackToggle = false;
    this.canPlaceObstacle = false;
    this.placing = false;

    this.isNetherite = this.checkNetherite();

    (async () => {
      /**
       * username : Team
       */
      const teams = this.#bot.teamMap;
      // console.log(teams);
      const botTeam = teams[bot.username];

      if (!botTeam) return console.log("pluh");

      const teamMember = botTeam.members;

      for (const member of teamMember) {
        if (member === this.#bot.username) continue;

        this.teamates.push(member);
      }
    })();

    // this.#bot.on("physicsTick", this.updateTick);
    this.#bot.on("death", this.stop);
    this.#bot.on("entityDead", (entity) => {
      if (!this.target) return;

      if (this.target.id === entity.id) {
        this.stop();
        this.emit("target-death", entity);
      }
    });

    this.startUpdateLoop();
  }

  getCurrentSettings() {
    return this.options;
  }

  updateSettings(newSettings) {
    Object.assign(this.options, newSettings);
  }

  updateSetting(key, value) {
    if (this.options.hasOwnProperty(key)) {
      this.options[key] = value;
    } else {
      console.error(`Setting ${key} does not exist.`);
    }
  }

  startUpdateLoop() {
    if (this.running) return;
    this.running = true;

    const tickRate = 50;

    const update = () => {
      if (!this.running) return;

      if (!this.paused) {
        const now = performance.now();
        const deltaTime = (now - this.lastUpdate) / 1000;
        this.lastUpdate = now;
        this.updateTick(deltaTime);
      }

      setTimeout(update, tickRate);
    };

    update();
  }

  pause(duration = null) {
    this.paused = true;
    if (duration !== null) {
      setTimeout(() => {
        this.paused = false;
        this.lastUpdate = performance.now(); // prevent huge delta after pause
      }, duration);
    }
  }

  resume() {
    this.paused = false;
    this.lastUpdate = performance.now(); // reset timing to avoid delta spike
  }

  stopUpdateLoop() {
    this.running = false;
  }
  checkNetherite() {
    const bot = this.#bot;
    let netheriteCount = 0;

    const armorSlots = [
      bot.getEquipmentDestSlot("head"),
      bot.getEquipmentDestSlot("torso"),
      bot.getEquipmentDestSlot("legs"),
      bot.getEquipmentDestSlot("feet"),
    ];

    for (const slot of armorSlots) {
      const item = bot.inventory.slots[slot];
      if (item && item.name.includes("netherite")) {
        netheriteCount++;
      }
    }

    return netheriteCount >= 3; // Threshold for "netherite PvP"
  }

  /**
   * Attacks the given target and returns a promise that resolves when the target is dead.
   * @param {Entity} target - The entity to attack.
   * @returns {Promise<void>} - Resolves when the target is dead.
   */
  attack(target) {
    if (!target) {
      return Promise.reject(new Error("No target specified"));
    }

    if (this.#attackTask) return;

    this.target = target;
    this.#attackTask = target;

    this.emit("target-aquired", target);

    return new Promise((resolve, reject) => {
      const onDeath = (entity) => {
        if (entity.id === target.id) {
          this.#bot.removeListener("entityDead", onDeath); // Clean up the listener

          if (
            this.possibleTargets.size > 0 &&
            this.possibleTargets.has(target.id)
          ) {
            this.possibleTargets.delete(target.id);
          }

          this.#attackTask = null;
          this.target = null; // Clear the target
          this.stop(!this.ffaToggle);
          resolve(); // Resolve the promise
        }
      };

      const onGone = (entity) => {
        if (entity.id === target.id) {
          this.#bot.removeListener("entityGone", onGone); // Clean up the listener

          if (
            this.possibleTargets.size > 0 &&
            this.possibleTargets.has(target.id)
          ) {
            this.possibleTargets.delete(target.id);
          }
          this.#attackTask = null;
          this.target = null; // Clear the target
          this.stop(!this.ffaToggle);
          resolve(); // Resolve the promise
        }
      };

      // If the bot dies or another error occurs, reject the promise
      const onError = () => {
        this.#bot.removeListener("entityDead", onDeath); // Clean up the listener
        this.#bot.removeListener("entityGone", onGone);
        this.#bot.removeListener("death", onError); // Clean up the listener
        this.#attackTask = null;
        this.target = null; // Clear the target
        reject("Bot died ig");
      };

      this.#bot.on("entityDead", onDeath);
      this.#bot.on("death", onError);
      this.#bot.on("entityGone", onGone);
    });
  }

  /**
   * Tell bot to attack anyone in sight
   */
  ffa(options = {}) {
    this.ffaToggle = !this.ffaToggle;
    this.ffaOptions = options;
  }

  /**
   * @param {Entity[]} mobs
   */
  async attackMobGroup(mobs) {
    // Sort mobs by proximity to the bot
    mobs.sort(
      (a, b) =>
        a.position.distanceTo(this.#bot.entity.position) -
        b.position.distanceTo(this.#bot.entity.position)
    );

    // Filter to get mobs within attack range
    const mobsToAttack = mobs.filter(
      (mob) => mob.position.distanceTo(this.#bot.entity.position) <= 3
    );

    // Create an array of promises for attacking the mobs
    const attackPromises = mobsToAttack.map((mob) => this.attack(mob));

    // Wait for all attacks to complete
    await Promise.all(attackPromises);

    // Remove attacked mobs from the original array
    for (const mob of mobsToAttack) {
      const index = mobs.indexOf(mob);
      if (index > -1) {
        mobs.splice(index, 1);
      }
    }
  }

  async ffaTick() {
    if (!this.ffaToggle) return;

    if (this.target) {
      const elapsed = Date.now() - this.targetAcquiredAt;
      if (elapsed < this.options.targetSwitchInterval) {
        return;
      }

      this.target = null;
      this.#attackTask = null;
    }

    const nearestPlayer = this.#bot.nearestEntity((entity) =>
      this.isValidTarget(entity)
    );
    if (!nearestPlayer) return;

    this.targetAcquiredAt = Date.now();

    try {
      await this.attack(nearestPlayer);
    } catch (error) {
      console.log("Error attacking player:", error);
    }
  }

  async isValidTarget(entity) {
    if (!entity || entity.type !== "player") return false;

    // Skip teammates
    if (this.teamates.includes(entity.username)) return false;

    // Skip kings
    if (this.#bot.hivemind.kings.includes(entity.username)) return false;

    // Skip connected BotMind bots if ignoreBotmind is false
    const connectedBotNames = this.#bot.hivemind.connectedBots.map(
      (bot) => bot.name
    );
    if (
      this.ffaOptions &&
      !this.ffaOptions.ignoreBotmind &&
      connectedBotNames.includes(entity.username)
    ) {
      return false;
    }

    //if target is dead or not in sight
    if (entity.health <= 0) {
      return false;
    }

    return true;
  }

  async semiFfaTick() {
    if (this.possibleTargets.size === 0) return;

    const targets = Array.from(this.possibleTargets);

    if (this.target) {
      const elapsed = Date.now() - this.targetAcquiredAt;
      if (elapsed < this.options.targetSwitchInterval) {
        return; // Continue attacking the current target
      }

      // Reset target after the interval
      this.target = null;
      this.#attackTask = null;
    }

    let closestTarget = null;
    let closestDistance = Infinity;

    for (const id of targets) {
      const entity = this.#bot.entities[id];

      if (!entity) {
        this.possibleTargets.delete(id);
        continue;
      }

      const distance = this.#bot.entity.position.distanceTo(entity.position);

      if (distance < closestDistance) {
        closestTarget = entity;
        closestDistance = distance;
      }
    }

    if (closestTarget) {
      this.targetAcquiredAt = Date.now();
      try {
        await this.attack(closestTarget);
      } catch (error) {
        console.log(error);
      }
    }
  }

  /**
   *
   * @param {number} deltaTime
   * @returns
   */
  updateAttackTime(deltaTime) {
    if (!this.target) return;

    // console.log(deltaTime);
    this.lastAttackTime += deltaTime * 1000;
    // console.log(this.lastAttackTime);
  }

  async crystalTick() {
    if (!this.options.crystalPvP) return; // Crystal PvP must be enabled
    if (!this.target) return; // No valid target

    const bot = this.#bot;
    const target = this.target;
    const distance = calculateDistanceInBox(
      bot.entity.position,
      target.position
    );

    if (distance > this.options.crystalDistance) return; // Target is too far

    // Find the best obsidian position for max damage
    const bestPos = this.#findGoodObi();
    if (!bestPos) {
      // Try placing obsidian
      const placePos = this.#findGoodObsidianPlacement();
      if (placePos && this.#hasObsidian()) {
        await this.#placeObsidian(placePos);
      }
      return;
    }

    // Check if an End Crystal already exists at this position
    const existingCrystal = bot.nearestEntity(
      (e) =>
        e.name === "end_crystal" &&
        e.position.floored().distanceTo(bestPos) <= 1.5
    );

    if (existingCrystal) {
      // console.log("yes");
      // If a crystal exists, check if we should detonate it
      if (this.#shouldDetonate(existingCrystal, target)) {
        this.#detonateCrystal(existingCrystal);
      }
      return;
    }

    // If no crystal exists, place one
    if (this.#hasEndCrystals()) {
      await this.#placeCrystal(bestPos);
    }
  }

  #hasObsidian() {
    const bot = this.#bot;
    return bot.inventory.items().some((item) => item.name === "obsidian");
  }

  async #placeObsidian(pos) {
    const bot = this.#bot;
    const obsidian = bot.inventory.items().find((i) => i.name === "obsidian");
    if (!obsidian) return;

    await bot.equip(obsidian, "hand");

    const above = pos.offset(0, 1, 0);
    await bot.placeBlock(bot.blockAt(pos), new Vec3(0, 1, 0)).catch((err) => {
      console.log("Failed to place obsidian:", err);
    });
  }

  /**
   * Checks if an End Crystal should be detonated based on the target's position.
   */
  #shouldDetonate(crystal, target) {
    const explosionDamage = this.#bot.getExplosionDamages(
      target,
      crystal.position,
      this.options.crystalDistance,
      true
    );
    return explosionDamage >= 6; // Detonate if expected damage is >= 6 hearts
  }

  /**
   * Detonates the End Crystal by attacking it.
   */
  async #detonateCrystal(crystal) {
    if (!crystal) return;
    this.#bot.setControlState("jump", false);
    this.#bot.attack(crystal);

    this.placingCrystal = false;
  }

  /**
   * Checks if the bot has End Crystals in inventory.
   */
  #hasEndCrystals() {
    return this.#bot.inventory
      .items()
      .some((item) => item.name === "end_crystal");
  }

  /**
   * Places an End Crystal at the given position.
   */
  async #placeCrystal(position) {
    const bot = this.#bot;
    if (!this.#hasEndCrystals()) return; // No crystals available

    this.placingCrystal = true;
    this.toggleUpdateMainHand();
    await bot.equip(
      bot.inventory.items().find((item) => item.name === "end_crystal")
    );

    // Place the End Crystal
    await placeBlock(bot, "end_crystal", position, false);

    // Immediately check if detonation is needed
    const placedCrystal = bot.nearestEntity(
      (e) => e.name === "end_crystal" && e.position.floored().equals(position)
    );

    if (placedCrystal && this.#shouldDetonate(placedCrystal, this.target)) {
      this.#detonateCrystal(placedCrystal);
    }

    this.placingCrystal = false;
    this.toggleUpdateMainHand();
  }

  attackTick() {
    if (!this.target || this.options.crystalPvP) return;

    const bot = this.#bot;
    const currentPosition = bot.entity.position;
    const targetPosition = this.target.position;

    const distance = calculate3DDistance(currentPosition, targetPosition);
    const verticalDifference = Math.abs(currentPosition.y - targetPosition.y);

    // While on cooldown, don't attack, but allow obstacle placement
    if (this.lastAttackTime < this.heldItemCooldown) {
      this.isAttacking = false;

      // Allow placing blocks if we are close enough to the enemy
      if (
        distance <= this.options.maxAttackDist &&
        !this.#eatingGap &&
        !this.placing
      ) {
        this.canPlaceObstacle = true;
      }

      // NEW: Bow fallback during cooldown if target is out of melee range but in follow range
      if (
        this.options.bowPvP &&
        this.#hasBow() &&
        distance > this.options.maxAttackDist &&
        distance <= this.options.followDistance
      ) {
        this.#rangedAttack();
      }

      return;
    }

    this.canPlaceObstacle = false;

    // NEW: Bow combat logic even outside of cooldown
    const useBowCombat =
      this.options.bowPvP &&
      this.#hasBow() &&
      ((distance > this.options.maxAttackDist &&
        distance <= this.options.followDistance) ||
        verticalDifference > 3);

    if (useBowCombat) {
      this.#rangedAttack();
      return;
    }

    // Melee combat logic
    if (
      distance <= this.options.maxAttackDist &&
      !this.#eatingGap &&
      !this.placing
    ) {
      this.isAttacking = true;

      if (distance > getRandomInRange(this.options.minAttackDist, 2.4)) {
        this.#performCombo();
        console.log(`HIT AT ${distance.toFixed(2)} WITH DISTANCE MODE`);
      } else {
        this.#predictiveAttack();
        console.log(`HIT AT ${distance.toFixed(2)} WITH CLOSE RANGE MODE`);
      }

      this.lastAttackTime = 0;
      bot.setControlState("jump", false);
    }
  }

  tryBowTarget() {
    if (!this.target) return;

    const currentPosition = this.#bot.entity.position;
    const targetPosition = this.target.position;
    const distance = calculateDistanceInBox(currentPosition, targetPosition);

    if (distance > this.options.maxAttackDist + 4 && this.#hasBow()) {
      this.canBowTarget = true;
      return;
    }

    this.canBowTarget = false;
  }

  #hasBow() {
    const bot = this.#bot;

    return (
      bot.inventory.items().find((item) => item.name === "bow") !== null &&
      bot.inventory.items().find((item) => item.name.includes("arrow")) !== null
    );
  }

  async #rangedAttack() {
    this.toggleUpdateMainHand();

    const bot = this.#bot;
    const bow = bot.inventory.items().find((item) => item.name === "bow");

    if (!bow) return;

    await bot.equip(bow, "hand");

    this.pause(1500);
    bot.hawkEye.oneShot(this.target, Weapons.bow);
    this.toggleUpdateMainHand();
  }

  // Predictive attack logic with single attack control
  #predictiveAttack() {
    this.#stap();
    const bot = this.#bot;

    if (this.isNetherite && Math.random() < this.options.critChance) {
      bot.setControlState("forward", false);
      bot.setControlState("sprint", false);
      bot.setControlState("jump", true);

      setTimeout(() => {
        bot.attack(this.target);
        bot.setControlState("jump", false);
        this.emit("hit");
      }, 100); // attack while falling
    } else {
      bot.setControlState("sprint", true); // reset sprint
      bot.attack(this.target);
      this.emit("hit");
    }
  }

  // Combo attack logic with improved timing control
  async #performCombo() {
    const bot = this.#bot;

    // If we're in Netherite PvP, attempt a proper crit
    if (this.isNetherite && Math.random() < this.options.critChance) {
      this.#bot.setControlState("forward", false);
      this.#bot.setControlState("sprint", false);
      this.#bot.setControlState("jump", true);
      this.#critting = true;

      // Wait ~100ms to be mid-air before attacking
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.#bot.attack(this.target);
      this.#bot.setControlState("jump", false);
    } else {
      // Non-Netherite (or failed crit chance) combo behavior
      this.#bot.attack(this.target);
    }

    // W-tap logic only when not critting (i.e., Diamond PvP)
    if (!this.#critting) {
      setTimeout(() => {
        if (Math.random() < 0.5) {
          this.#wtap();
        } else {
          this.#stap();
        }
      }, getRandomInRange(1, 5));
    }

    this.#critting = false;
    this.emit("comboHit");
  }

  // Adaptive dodge to evade incoming attacks
  #adaptiveDodge() {
    const dodgeDirection = Math.random() > 0.5 ? "left" : "right";
    this.#bot.setControlState(dodgeDirection, true);

    setTimeout(() => {
      this.#bot.setControlState(dodgeDirection, false);
    }, 1000);
  }

  // W-tap technique to reset sprint and increase knockback
  #wtap() {
    this.#wtapping = true;
    this.#bot.setControlState("sprint", false);
    this.#bot.setControlState("forward", false);

    setTimeout(() => {
      this.#bot.setControlState("sprint", true);
      this.#bot.setControlState("forward", true);
      this.#wtapping = false;
    }, 50);
  }

  #stap() {
    this.#stapping = true;
    this.#bot.setControlState("sprint", false);
    this.#bot.setControlState("forward", false);
    this.#bot.setControlState("back", true);

    setTimeout(() => {
      this.#bot.setControlState("sprint", true);
      this.#bot.setControlState("forward", true);
      this.#bot.setControlState("back", false);
      this.#stapping = false;
    }, 30);
  }

  #toggleStrafeDirection() {
    this.currentStrafeDirection =
      this.currentStrafeDirection === "left" ? "right" : "left";
  }

  /**
   * Runs every tick
   * @param {number} deltaTime
   */
  updateTick(deltaTime) {
    this.heldItemCooldown = this.calculateHeldItemCooldown();
    this.updateTeamates();
    this.updateAttackTime(deltaTime);
    this.isNetherite = this.checkNetherite();

    this.lookAtTarget();
    // this.trackTarget();
    this.ffaTick();
    this.semiFfaTick();
    this.followTarget();
    this.equip();
    if (this.combatEnabled) {
      this.eatGap();
      this.updateMainHand();
      this.updateOffhand();
      this.placeObstacle();
      this.attackTick();
      this.crystalTick();
    }
  }

  enableCombat() {
    this.combatEnabled = true;
  }

  disableCombat() {
    this.combatEnabled = false;
  }

  updateTeamates() {
    const teams = this.#bot.teamMap;
    const botTeam = teams[this.#bot.username];

    if (!botTeam) return;

    const teamMember = botTeam.members;

    for (const member of teamMember) {
      if (member === this.#bot.username) continue;

      if (this.teamates.includes(member)) continue;

      this.teamates.push(member);
    }
  }

  test(target) {
    const path = astar(this.#bot, this.#bot.entity.position, target.position);

    console.log(path);
  }

  //#region movement

  async followTarget() {
    if (!this.target) return;

    const botPos = this.#bot.entity.position;
    const targetPos = this.target.position;
    const distance = calculateDistanceInBox(botPos, targetPos);
    const targetMoved =
      this.lastTargetPos && this.lastTargetPos.distanceTo(targetPos) > 1.5;

    // If target moved significantly or we have no path, recalculate
    if (
      (!this.lastPath ||
        targetMoved ||
        this.pathIndex >= this.lastPath.length) &&
      !this.isPathing
    ) {
      this.#bot.clearControlStates();
      this.isPathing = true;
      this.pause();

      const path = astar(this.#bot, botPos, targetPos);
      if (!path || path.length === 0) {
        console.log("No path found, fallback.");
        this.isPathing = false;
        this.tryBowTarget?.();
        this.resume();
        return;
      }

      this.lastPath = path;
      this.pathIndex = 0;
      this.lastTargetPos = targetPos.clone();

      await this.#moveAlongPath();
      return;
    }

    // Fallback to normal movement/PvP logic if already in range
    if (this.placing) return;

    if (this.options.bowPvP) {
      this.#handleBowStrafe(distance);
    } else if (!this.#critting && !this.isPathing) {
      this.#bot.setControlState("forward", true);
      this.#bot.setControlState("sprint", true);

      if (distance > this.options.maxAttackDist && !this.options.crystalPvP) {
        this.#bot.setControlState("jump", true);
      }

      this.#handleDynamicStrafe(distance);
      this.#handleCollisionJump();
    }
  }

  async #moveAlongPath() {
    const path = this.lastPath;
    this.#bot.clearControlStates();

    while (this.pathIndex < path.length && this.target) {
      const point = path[this.pathIndex];
      const targetVec = new Vec3(point.x, point.y, point.z);
      const botPos = this.#bot.entity.position;
      const dist = botPos.distanceTo(targetVec);

      this.#bot.lookAt(targetVec.offset(0, 1.6, 0), true);

      // Jump logic
      const verticalDiff = targetVec.y - botPos.y;
      if (verticalDiff > 0.1 && this.#bot.entity.onGround) {
        this.#bot.setControlState("jump", true);
      } else {
        this.#bot.setControlState("jump", false);
      }

      this.#bot.setControlState("forward", true);
      this.#bot.setControlState("sprint", dist > 3 && verticalDiff < 0.1);

      if (dist < 0.6) this.pathIndex++;

      const targetDist = this.#bot.entity.position.distanceTo(
        this.target.position
      );
      if (targetDist <= this.options.maxFollowRange) {
        console.log("Close enough, stop pathing.");
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    this.isPathing = false;
    this.resume();
    this.#bot.clearControlStates();
  }

  #handleBowStrafe(distance) {
    const idealRange = 12;
    const tolerance = 1.5;

    if (distance < idealRange - tolerance) {
      this.#bot.setControlState("back", true);
      this.#bot.setControlState("forward", false);
    } else if (distance > idealRange + tolerance) {
      this.#bot.setControlState("forward", true);
      this.#bot.setControlState("back", false);
    } else {
      this.#bot.setControlState("forward", false);
      this.#bot.setControlState("back", false);

      const now = Date.now();
      if (now - this.lastStrafeChangeTime > this.strafeDuration) {
        this.#toggleStrafeDirection();
        this.lastStrafeChangeTime = now;
      }

      this.#bot.setControlState("left", this.currentStrafeDirection === "left");
      this.#bot.setControlState(
        "right",
        this.currentStrafeDirection === "right"
      );
    }

    this.#bot.setControlState("sprint", false);
    this.#bot.setControlState("jump", false);
    this.isPathing = false;
  }

  #handleDynamicStrafe(distance) {
    const inRange = distance <= this.options.minAttackDist + 1.0;
    const now = Date.now();
    if (inRange && now - this.lastStrafeChangeTime >= this.strafeDuration) {
      this.#toggleStrafeDirection();
      this.lastStrafeChangeTime = now;
    }

    this.#bot.setControlState(
      "left",
      inRange && this.currentStrafeDirection === "left"
    );
    this.#bot.setControlState(
      "right",
      inRange && this.currentStrafeDirection === "right"
    );

    if (!inRange) {
      this.#bot.setControlState("left", false);
      this.#bot.setControlState("right", false);
    }
  }

  #handleCollisionJump() {
    if (this.#bot.entity.isCollidedHorizontally) {
      this.#bot.setControlState("jump", true);
      setTimeout(() => this.#bot.setControlState("jump", false), 200);
    }
  }

  //#endregion

  async waitForPearl() {
    return new Promise((resolve) => {
      this.#bot.once("forcedMove", () => {
        resolve();
      });
    });
  }

  getGapEatStats() {
    return {
      timesEaten: this.#gapEatCount,
      lastAte: new Date(this.#lastGapEatTime).toLocaleTimeString(),
    };
  }

  async eatGap() {
    const now = Date.now();
    const bot = this.#bot;

    // Basic conditions
    if (!this.target) {
      if (this.#debugEatGap) console.log("[eatGap] Skipping: No target");
      return;
    }

    const health = bot.health;
    const effects = bot.entity.effects;

    // Adaptive cooldown (shorter if health is low)
    const pressureCooldown = health <= 10 ? 1500 : this.#gapCooldownMs;
    if (now - this.#lastGapEatTime < pressureCooldown) {
      if (this.#debugEatGap)
        console.log(
          `[eatGap] Skipping: Cooldown active (${
            now - this.#lastGapEatTime
          }ms ago)`
        );
      return;
    }

    if (health > 15) {
      if (this.#debugEatGap)
        console.log(`[eatGap] Skipping: Health is ${health}`);
      return;
    }

    if (effects["10"] && health > 17) {
      if (this.#debugEatGap)
        console.log("[eatGap] Skipping: Regeneration effect active");
      return;
    }

    if (this.#eatingGap) {
      if (this.#debugEatGap) console.log("[eatGap] Skipping: Already eating");
      return;
    }

    // Priority logic: Only eat if you're in a 1vX situation or close to death
    const nearbyHostiles = bot.nearestEntity(
      (entity) =>
        entity.type === "mob" &&
        entity.position.distanceTo(bot.entity.position) <= 6 &&
        entity.name !== bot.username
    );
    const enemyClose =
      this.target.position.distanceTo(bot.entity.position) <= 3;

    const multipleEnemies =
      Array.isArray(bot.players) &&
      Object.values(bot.players).filter(
        (p) =>
          p.entity &&
          p.entity.position.distanceTo(bot.entity.position) < 6 &&
          p.username !== bot.username
      ).length > 1;

    if (!multipleEnemies && enemyClose && health > 10) {
      if (this.#debugEatGap)
        console.log(
          "[eatGap] Skipping: Only 1 enemy close and health is not low"
        );
      return;
    }

    // Find golden apple
    const gap = bot.inventory.slots.find(
      (item) => item && item.name.includes("golden_apple")
    );
    if (!gap) {
      if (this.#debugEatGap)
        console.log("[eatGap] Skipping: No golden apple in inventory");
      return;
    }

    const offHandSlot = bot.getEquipmentDestSlot("off-hand");
    const gapInOffhand =
      bot.inventory.slots[offHandSlot]?.name.includes("golden_apple");

    // Begin eating process
    this.#eatingGap = true;
    this.#lastGapEatTime = now;
    this.#gapEatCount++;
    bot.autoEat.disable();
    this.toggleUpdateOffhand();
    this.pause();

    if (this.#debugEatGap)
      console.log(
        `[eatGap] 🍏 Eating golden apple [#${
          this.#gapEatCount
        }] | Health: ${health} | Under pressure: ${multipleEnemies}`
      );

    try {
      if (!gapInOffhand) {
        if (this.#debugEatGap)
          console.log("[eatGap] Equipping golden apple to off-hand");
        await bot.equip(gap, "off-hand");
      } else {
        if (this.#debugEatGap)
          console.log("[eatGap] Golden apple already in off-hand");
      }

      bot.activateItem(true);
      await sleep(1601);
      bot.deactivateItem(true);

      if (this.#debugEatGap) console.log("[eatGap] ✅ Finished eating");
    } catch (err) {
      console.error("[eatGap] ❌ Error while eating:", err);
    }

    this.resume();
    bot.autoEat.enable();
    this.toggleUpdateOffhand();
    this.#eatingGap = false;
  }
  #lastLookUpdate = 0;
  #lookCooldown = 50; // ms between forced look updates (to reduce jitter)

  lookAtTarget(force = false) {
    if (!this.target || this.isPathing || this.placing || this.#eatingGap)
      return;

    const now = Date.now();
    if (!force && now - this.#lastLookUpdate < this.#lookCooldown) return;

    const bot = this.#bot;
    const pos = bot.entity.position;
    const targetPos = this.target.position;

    const dx = targetPos.x - pos.x;
    const dz = targetPos.z - pos.z;

    const desiredYaw = Math.atan2(-dx, -dz);
    const currentYaw = bot.entity.yaw;

    const deltaYaw = Math.abs(desiredYaw - currentYaw);

    // Minimum threshold to rotate (avoids micro-adjustment)
    const yawThreshold = 0.01;

    if (deltaYaw > yawThreshold || force) {
      this.#lastLookUpdate = now;
      // Fast look with no await – use "force" true to skip smooth interpolation
      bot.look(desiredYaw, 0, true); // pitch 0 is assumed here; can calculate if needed
    }
  }

  calculateHeldItemCooldown() {
    const heldItem = this.#bot.heldItem;

    if (!heldItem) return 1;

    const seconds = getSpeed(heldItem);
    const cooldown = Math.floor((1 / seconds) * 1000);

    return cooldown - getRandomInRange(50, 100);
  }

  /**
   *
   * @param {Entity} entity
   */
  isPartOfTeam(entity) {
    return this.teamates.includes(entity.username);
  }

  async equip() {
    const bot = this.#bot;

    const getBestArmor = (type) => {
      const equipmentSlot = bot.getEquipmentDestSlot(type);
      const currentArmor = bot.inventory.slots[equipmentSlot];

      return bot.inventory.items().reduce((bestArmor, item) => {
        if (armorMap[item.name.toLowerCase()] !== type) return bestArmor;

        const itemPoints = armorPointsMap[item.name.toLowerCase()] || 0;
        const currentPoints =
          armorPointsMap[currentArmor?.name?.toLowerCase()] || 0;

        return itemPoints > currentPoints ? item : bestArmor;
      }, null);
    };

    const armorTypes = ["head", "torso", "legs", "feet"];

    for (const type of armorTypes) {
      const bestArmor = getBestArmor(type);
      if (bestArmor) await bot.equip(bestArmor, type);
    }
  }

  async trackTarget() {
    if (!this.target) return;

    if (this.#eatingGap) return;

    if (this.placing) return;

    const entity = this.target;

    function predictFuturePosition(timeAhead = 450) {
      if (!entity || !entity.position || !entity.velocity)
        return entity?.position;

      const futurePos = entity.position
        .clone()
        .add(entity.velocity.clone().scale(timeAhead / 1000));
      return futurePos;
    }

    const predicted = predictFuturePosition();

    this.#bot.lookAt(predicted.offset(0, 1.1, 0), true);
  }

  #findGoodObi() {
    const target = this.target;

    if (!target) return null;

    const nearbyObi = this.#bot
      .findBlocks({
        matching: (block) => block.name.includes("obsidian"),
        maxDistance: this.options.crystalDistance,
        point: target.position,
      })
      .sort((a, b) => {
        const distA = calculateDistanceInBox(target.position, a, true);
        const distB = calculateDistanceInBox(target.position, b, true);
        if (distA !== distB) return distA - distB;
        return a.y - b.y || a.x - b.x || a.z - b.z;
      });

    if (nearbyObi.length === 0) return null;

    let bestObi = null;
    let highestDamage = 0;

    for (const pos of nearbyObi) {
      const damage = this.#bot.getExplosionDamages(
        target,
        pos,
        this.options.crystalDistance,
        true
      );

      if (damage >= 12 && damage > highestDamage) {
        // 12 HP = 6 hearts
        highestDamage = damage;
        bestObi = pos;
      }
    }

    return bestObi.floored(); // Returns the best obsidian block for max damage
  }

  #findGoodObsidianPlacement() {
    const bot = this.#bot;
    const target = this.target;
    if (!target) return null;

    const origin = target.position.floored();

    const candidateOffsets = [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(1, 0, 1),
      new Vec3(-1, 0, -1),
      new Vec3(1, 0, -1),
      new Vec3(-1, 0, 1),
      new Vec3(0, -1, 0), // Directly below target (optional)
    ];

    let bestPos = null;
    let bestScore = -Infinity;

    for (const offset of candidateOffsets) {
      const pos = origin.plus(offset);

      const blockBelow = bot.blockAt(pos);
      const blockAtPos = bot.blockAt(pos.offset(0, 1, 0));
      const blockAbove = bot.blockAt(pos.offset(0, 2, 0));

      const canPlace =
        blockBelow &&
        blockBelow.name !== "air" && // Has something to place on
        blockAtPos &&
        blockAtPos.name === "air" &&
        blockAbove &&
        blockAbove.name === "air";

      const distance = bot.entity.position.distanceTo(pos);

      if (
        canPlace &&
        distance <= 4.5 && // Within reach
        bot.canSeeBlock(bot.blockAt(pos.offset(0, 1, 0))) // Can see top face
      ) {
        const damage = bot.getExplosionDamages(
          target,
          pos.offset(0, 1, 0),
          this.options.crystalDistance,
          true
        );

        if (damage > bestScore) {
          bestScore = damage;
          bestPos = pos;
        }
      }
    }

    return bestPos; // Where to place obsidian
  }

  async placeObstacle() {
    if (!this.target) return;

    if (!this.canPlaceObstacle) return;

    if (this.#eatingGap) return;

    if (!this.target.onGround) return;

    // Find obstacle items
    const itemNames = ["flint_and_steel", "lava_bucket", "cobweb"];
    const items = itemNames
      .map((name) =>
        this.#bot.inventory.items().find((i) => i.name.includes(name))
      )
      .filter(Boolean);

    if (items.length === 0) return;

    // Find the nearest enemy within 3 blocks
    const near =
      calculateDistanceInBox(this.#bot.entity.position, this.target.position) <
      4;
    if (!near) return;

    // Check if the enemy is already in a cobweb
    const blockUnderNear = this.#bot.blockAt(
      this.target.position.offset(0, -1, 0)
    );
    if (blockUnderNear?.name === "cobweb") return;

    // Select a random item
    const randomItem = items[Math.floor(Math.random() * items.length)];
    if (this.placing) return;

    this.toggleUpdateMainHand();
    this.placing = true;
    this.#bot.clearControlStates();
    this.#bot.setControlState("jump", false);

    try {
      this.pause();
      await this.#bot.equip(randomItem, "hand");

      const placePos = this.target.position;
      await this.#bot.lookAt(placePos, true);

      // Check if the target is moving slowly
      const isStationary =
        Math.abs(this.target.velocity.x) < 0.2 &&
        Math.abs(this.target.velocity.z) < 0.2;

      if (randomItem.name.includes("flint_and_steel")) {
        if (isStationary) {
          await sleep(100);
          this.#bot.activateItem();
          await sleep(100);
          this.#bot.activateItem();
        }
      } else if (randomItem.name.includes("lava_bucket")) {
        if (isStationary) {
          await sleep(100);
          this.#bot.activateItem();
          await sleep(100);
          this.#bot.activateItem();
        }
      } else if (randomItem.name.includes("cobweb")) {
        await placeBlock(this.#bot, "cobweb", placePos);
      }

      await sleep(300);
    } catch (err) {
      //
      console.log(err);
      this.toggleUpdateMainHand();
      this.placing = false;
      this.resume();
    } finally {
      this.toggleUpdateMainHand();
      this.placing = false;
      this.resume();
    }
  }

  async pearlAway(offestEntity = this.#bot.entity) {
    const { position } = offestEntity;
    let block = null;
    let foundBlock = false;
    let success = false;
    let retries = 0;
    let maxDistance = 10;
    let minDistance = 5;
    let MaxTries = 3;

    const getBlock = () => {
      for (let i = 0; i < 20; i++) {
        const offset = position.offset(
          Math.floor(Math.random() * (maxDistance - minDistance)) + minDistance,
          0,
          Math.floor(Math.random() * (maxDistance - minDistance)) + minDistance
        );
        block = this.bot.blockAt(offset, true);
        console.log("===========================");
        console.log(
          `Checking block at (${Math.floor(offset.x)}, ${Math.floor(
            offset.y
          )}, ${Math.floor(offset.z)})`
        );
        if (block) {
          console.log(
            `Block found at (${Math.floor(offset.x)}, ${Math.floor(
              offset.y
            )}, ${Math.floor(offset.z)})`
          );
          foundBlock = true;
          break;
        }
      }
    };

    while (!success && retries < MaxTries) {
      getBlock();

      if (foundBlock) {
        this.isPearling = true;
        if (this.#bot.getControlState("forward")) {
          this.#bot.setControlState("forward", false);
        }

        if (this.#bot.health <= 8) {
          this.isPearling = false;
          return false;
        }

        const pearl = this.#bot.inventory
          .items()
          .find((item) => item.name === "ender_pearl");

        if (!pearl) {
          this.isPearling = false;
          return false;
        }
        console.log(`Pearl item found: ${pearl?.count}`);
        const shot = this.#bot.hawkEye.getMasterGrade(
          { position: block.position },
          new Vec3(0, 0.05, 0),
          "ender_pearl"
        );
        console.log(
          `Shot information: ${shot ? Math.floor(shot.yaw) : "nope"}, ${
            shot ? Math.floor(shot.pitch) : "nada"
          }`
        );
        await this.#bot.equip(pearl, "hand");
        try {
          if (shot) {
            await this.#bot.look(shot.yaw, shot.pitch, true);
            await this.#bot.equip(pearl, "hand");
            this.#bot.activateItem(false);

            await this.waitForPearl();
            this.isPearling = false;
            success = true;
            console.log("Pearling succeeded");
            return success;
          }
        } catch {
          console.error("Pearling failed");
        }
        if (!success) {
          console.log(`Retry ${retries + 1}`);
          retries++;
          await sleep(500); // wait 1 second before retrying
        }
      } else {
        console.log("No block found after 20 ts");
        return false;
      }
    }

    this.isPearling = false;
  }

  toggleUpdateMainHand() {
    this.#canUpdateMainHand = !this.#canUpdateMainHand;
  }

  toggleUpdateOffhand() {
    this.#canUpdateOffhand = !this.#canUpdateOffhand;
  }

  canUpdateMainHand() {
    return this.#canUpdateMainHand;
  }

  canUpdateOffHand() {
    return this.#canUpdateOffhand;
  }

  async updateMainHand() {
    if (!this.canUpdateMainHand()) return;
    if (this.placing) return;
    if (this.placingCrystal) return;

    const bot = this.#bot;

    // List of weapon types
    const weaponTypes = ["sword", "axe", "trident"];

    // Get all weapons in inventory
    let weapons = bot.inventory
      .items()
      .filter((item) => weaponTypes.some((type) => item.name.includes(type)));

    // Function to calculate total damage
    const getItemTotalDamage = (item) => {
      let baseDamage = weaponBase[item.name] || 0;
      const attackSpeed = getSpeed(item.name) || 1.6; // Default sword speed
      const enchantments = getItemEnchantments(item);

      // Calculate Sharpness bonus
      for (const enchantment of enchantments) {
        if (enchantment.name.split(":")[1] === "sharpness") {
          const enchantDamage = 0.5 * enchantment.level + 0.5;
          baseDamage += enchantDamage;
        }
      }

      // Effective damage: Base Damage * Attack Speed (considering speed importance)
      return baseDamage * (attackSpeed / 4); // Normalize speed scaling
    };

    // Sort weapons by effective damage
    const sortedWeapons = weapons.slice().sort((a, b) => {
      return getItemTotalDamage(b) - getItemTotalDamage(a);
    });

    const bestWeapon = sortedWeapons[0];
    if (!bestWeapon) return;

    // Prevent switching if already holding the best weapon
    if (bot.heldItem && bot.heldItem.name === bestWeapon.name) return;

    // Equip the best weapon
    await bot.equip(bestWeapon, "hand");
  }
  ///give @s iron_sword[custom_name='["",{"text":"Oblitarator","italic":false,"color":"dark_red","bold":true}]',lore=['["",{"text":"Death","italic":false}]'],rarity=epic,enchantments={levels:{sharpness:10},show_in_tooltip:false},unbreakable={}]
  async updateOffhand() {
    if (!this.canUpdateOffHand()) return;
    if (this.#bot.supportFeature("doesntHaveOffHandSlot")) return;
    if (this.#eatingGap) return;
    if (this.#bot?.autoEat && this.#bot.autoEat.isEating) return;

    // Get all valid offhand items
    const validItems = this.#bot.inventory.slots.filter(
      (item) => item !== null && offhandPriority[item.name] !== undefined
    );

    // Sort items based on priority (higher = better)
    validItems.sort(
      (a, b) => offhandPriority[b.name] - offhandPriority[a.name]
    );

    // Prefer totem if available unless bot is eating
    let bestItem =
      validItems.find((item) => item.name === "totem_of_undying") ||
      validItems.find((item) => item.name.includes("golden_apple")) ||
      validItems[0];

    // No valid item
    if (!bestItem) return;

    // Get current offhand item
    const offhandSlot = this.#bot.getEquipmentDestSlot("off-hand");
    const offHandItem = this.#bot.inventory.slots[offhandSlot];

    // Prevent unnecessary re-equipping
    if (offHandItem?.name === bestItem.name) return;

    // Prevent repeated switching
    if (this.#lastSelectedOffhand === bestItem.name) return;

    // Equip the best item
    await this.#bot.equip(bestItem, "off-hand");

    // Store the last selected item
    this.#lastSelectedOffhand = bestItem.name;
  }

  stop(withFFA = true) {
    if (withFFA) this.ffaToggle = false;
    this.trackToggle = false;
    this.target = null;
    this.possibleTargets.clear();
    this.#bot.clearControlStates();
  }
}

module.exports = AshPvP;
