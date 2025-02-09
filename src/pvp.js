const Entity = require("prismarine-entity").Entity;
const Vec3 = require("vec3").Vec3;

const EventEmitter = require("events");

const armorMap = require("./utils/armorMap.json");
const armorPointsMap = require("./utils/armorPoints.json");
const weaponBase = require("./utils/weaponBase.json");
const offhandPriority = require("./utils/offhandPriority.json");

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

  /**
   * @type {string}
   */
  #lastSelectedOffhand = null;

  constructor(bot) {
    super();
    /**
     * @type {import("mineflayer").Bot}
     */
    this.#bot = bot;
    this.running = false;
    this.lastUpdate = performance.now();

    this.options = {
      /**
       * The minimum attack distance/reach
       */
      minAttackDist: 2,
      /**
       * The maximum attack distance/reach
       */
      maxAttackDist: 3,
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
      crystalDistance: 6,
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

    this.trackToggle = false;
    this.canPlaceObstacle = false;
    this.placing = false;

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

  startUpdateLoop() {
    if (this.running) return;
    this.running = true;

    const tickRate = 50; // Run the loop every 50ms (20 times per second)

    const update = () => {
      if (!this.running) return;

      const now = performance.now();
      const deltaTime = (now - this.lastUpdate) / 1000;
      this.lastUpdate = now;

      this.updateTick(deltaTime);

      setTimeout(update, tickRate);
    };

    update();
  }

  stopUpdateLoop() {
    this.running = false;
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
          this.stop();
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
          this.stop();
          resolve(); // Resolve the promise
        }
      };

      // If the bot dies or another error occurs, reject the promise
      const onError = () => {
        this.#bot.removeListener("entityDead", onDeath); // Clean up the listener
        this.#bot.removeListener("entityGone", onGone);
        this.#bot.removeListener("death", onError); // Clean up the listener
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
  ffa() {
    this.ffaToggle = !this.ffaToggle;
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

    // If there's an active target, check if we should switch after some time
    if (this.target) {
      const elapsed = Date.now() - this.targetAcquiredAt;
      if (elapsed < this.options.targetSwitchInterval) {
        return; // Continue attacking the current target
      }

      // Reset target after the interval
      this.target = null;
      this.#attackTask = null;
    }

    // Find the nearest player who is not a teammate or a king
    const nearestPlayer = this.#bot.nearestEntity((entity) => {
      return (
        entity.type === "player" &&
        !this.teamates.includes(entity.username) &&
        !this.#bot.hivemind.kings.includes(entity.username)
      );
    });

    if (!nearestPlayer) return;

    // Set the new target and track the acquisition time
    this.targetAcquiredAt = Date.now();

    // Attack the target
    try {
      await this.attack(nearestPlayer);
    } catch (error) {
      console.log(error);
    }

    // Optionally clear the target after attacking (if immediate switching is desired)
    // this.target = null;
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
    if (!bestPos) return; // No good position found

    // Check if an End Crystal already exists at this position
    const existingCrystal = bot.findEntity({
      matching: (e) =>
        e.name === "end_crystal" && e.position.floored().equals(bestPos),
    });

    if (existingCrystal) {
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
    await this.#bot.attack(crystal);
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

    // Place the End Crystal
    await bot.placeBlock(bot.blockAt(position), new Vec3(0, 1, 0));

    // Immediately check if detonation is needed
    const placedCrystal = bot.findEntity({
      matching: (e) =>
        e.name === "end_crystal" && e.position.floored().equals(position),
    });

    if (placedCrystal && this.#shouldDetonate(placedCrystal, this.target)) {
      this.#detonateCrystal(placedCrystal);
    }
  }

  attackTick() {
    if (!this.target) return;

    if (this.lastAttackTime < this.heldItemCooldown) {
      //We still on cooldown
      const currentPosition = this.#bot.entity.position;
      const targetPosition = this.target.position;
      const distance = calculateDistanceInBox(currentPosition, targetPosition);
      this.isAttacking = false;
      if (
        between(distance, this.options.maxAttackDist, 4) &&
        !this.#eatingGap &&
        !this.placing
      ) {
        this.canPlaceObstacle = true;
      }
      return;
    }

    this.canPlaceObstacle = false;
    const currentPosition = this.#bot.entity.position;
    const targetPosition = this.target.position;
    const distance = calculateDistanceInBox(currentPosition, targetPosition);

    // const mainHand = this.#bot.heldItem ? this.#bot.heldItem.name : null;

    // if (distance > this.options.maxAttackDist + 4 && this.#hasBow()) {
    //   this.isAttacking = false;
    //   this.#rangedAttack(distance);
    //   return;
    // }

    if (
      distance <= this.options.maxAttackDist &&
      !this.#eatingGap &&
      !this.placing
    ) {
      this.canPlaceObstacle = false;
      this.isAttacking = true;

      if (distance > getRandomInRange(this.options.minAttackDist, 2.4)) {
        this.#performCombo();
        console.log(`HIT AT ${distance.toFixed(2)} WITH AT DISTANCE MODE`);
      } else {
        this.#predictiveAttack();
        console.log(`HIT AT ${distance.toFixed(2)} WITH CLOSE RANGE MODE`);
      }

      this.lastAttackTime = 0;
      this.#bot.setControlState("jump", false);
    }
  }

  #hasBow() {
    const bot = this.#bot;

    return (
      bot.inventory.items().find((item) => item.name === "bow") !== null &&
      bot.inventory.items().find((item) => item.name.includes("arrow")) !== null
    );
  }

  async #rangedAttack(distance) {
    this.toggleUpdateMainHand();

    const bot = this.#bot;
    const bow = bot.inventory.items().find((item) => item.name === "bow");

    if (!bow) return;

    await bot.equip(bow, "hand");

    bot.clearControlStates();
    bot.hawkEye.oneShot(this.target, Weapons.bow);
    this.toggleUpdateMainHand();
  }

  // Predictive attack logic with single attack control
  #predictiveAttack() {
    this.#stap();

    this.#bot.setControlState("sprint", true); // Reset sprint to gain momentum
    this.#bot.attack(this.target);

    this.emit("hit");
  }

  // Combo attack logic with improved timing control
  async #performCombo() {
    if (Math.random() < this.options.critChance) {
      this.#bot.setControlState("jump", true);
      this.#bot.setControlState("forward", false);
      this.#bot.setControlState("sprint", false);
      this.#critting = true;
    }

    this.#bot.attack(this.target);

    if (!this.#critting)
      setTimeout(() => {
        if (Math.random() < 0.5) {
          this.#wtap();
        } else this.#stap();

        // this.#adaptiveDodge();
      }, getRandomInRange(1, 5));

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

    this.eatGap();
    // this.lookAtTarget();
    this.trackTarget();
    this.ffaTick();
    this.semiFfaTick();
    this.followTarget();
    this.equip();
    this.updateMainHand();
    this.updateOffhand();
    this.placeObstacle();
    this.attackTick();
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

  async followTarget() {
    if (!this.target) return;

    const currentPosition = this.#bot.entity.position;
    const targetPosition = this.target.position;
    const distance = calculateDistanceInBox(currentPosition, targetPosition);

    const now = Date.now();

    if (distance > this.options.maxFollowRange) {
      // if (
      //   this.lastPath.length === 0 || // No path stored
      //   this.pathIndex >= this.lastPath.length || // Reached end of path
      //   now - this.lastAStarTime > 1000 || // Cooldown expired
      //   calculateDistanceInBox(
      //     this.lastPath[this.lastPath.length - 1],
      //     targetPosition
      //   ) > this.recalculateThreshold // Target moved
      // ) {
      //   this.lastPath = aStar(this.#bot, currentPosition, targetPosition) || [];
      //   this.pathIndex = 0;
      //   this.lastAStarTime = now;
      // }

      // // Follow the path
      // if (this.lastPath.length > 1 && this.pathIndex < this.lastPath.length) {
      //   const nextNode = this.lastPath[this.pathIndex];
      //   this.isPathing = true;

      //   // Move to next position
      //   this.#bot.lookAt(
      //     new Vec3(nextNode.x, currentPosition.y + 1.5, nextNode.z)
      //   );
      //   this.#bot.setControlState("forward", true);

      //   // Move to the next node when close enough
      //   if (calculateDistanceInBox(currentPosition, nextNode) < 0.5) {
      //     this.pathIndex++;
      //   }
      // }

      return;
    }

    if (this.placing) return;

    if (distance <= 1.8) {
      this.#bot.setControlState("back", true);
      this.#bot.setControlState("forward", false);
      this.#bot.setControlState("sprint", false);
      this.#bot.setControlState("jump", false);
      this.isPathing = false;
      return;
    }

    if (!this.#critting && !this.isPathing) {
      this.#bot.setControlState("back", false);
      this.#bot.setControlState("forward", true);
      this.#bot.setControlState("sprint", true);

      if (distance > this.options.maxAttackDist) {
        this.#bot.setControlState("jump", true);
      }
    }

    // Strafe dynamically if close to the target
    if (distance <= this.options.minAttackDist + 1.0) {
      const currentTime = Date.now();
      if (currentTime - this.lastStrafeChangeTime >= this.strafeDuration) {
        this.#toggleStrafeDirection();
        this.lastStrafeChangeTime = currentTime;
      }

      if (this.currentStrafeDirection === "left") {
        this.#bot.setControlState("left", true);
        this.#bot.setControlState("right", false);
      } else {
        this.#bot.setControlState("left", false);
        this.#bot.setControlState("right", true);
      }
    } else {
      // Stop strafing when far from the target
      this.#bot.setControlState("left", false);
      this.#bot.setControlState("right", false);
    }

    if (this.#bot.entity.isCollidedHorizontally) {
      this.#bot.setControlState("jump", true);
      setTimeout(() => this.#bot.setControlState("jump", false), 200);
    }
  }

  async eatGap() {
    if (!this.target) return; //really on auto eat plugin

    const health = this.#bot.health;

    // Don't eat if health is above 15
    if (health > 15) return;

    const gap = this.#bot.inventory.slots.find(
      (item) => item !== null && item.name.includes("golden_apple")
    );

    if (!gap) return;

    const ofhandslot = this.#bot.getEquipmentDestSlot("off-hand");
    let hasGapInOffhand =
      this.#bot.inventory.slots[ofhandslot] !== null &&
      this.#bot.inventory.slots[ofhandslot].name.includes("golden_apple");

    // effect object with the key being the effect's id
    const effects = this.#bot.entity.effects;

    // If we have regeneration and health is decent, don't eat
    if (effects["10"] && health > 17) return;

    // If already eating, return
    if (this.#eatingGap) return;

    // ⚠️ Avoid eating when an enemy is nearby!
    const enemyNearby = this.#bot.nearestEntity(
      (entity) =>
        entity.id === this.target.id &&
        entity.position.distanceTo(this.#bot.entity.position) < 3
    );

    if (enemyNearby && health > 10) return; // Only eat if we're in danger

    this.#eatingGap = true;
    this.#bot.autoEat.disable();
    this.toggleUpdateOffhand();

    if (hasGapInOffhand) {
      this.#bot.activateItem(true);
      await sleep(1601);
      this.#bot.deactivateItem(true);
    } else {
      await this.#bot.equip(gap, "off-hand");

      this.#bot.activateItem(true);
      await sleep(1601);
      this.#bot.deactivateItem(true);
    }

    this.#eatingGap = false;
    this.#bot.autoEat.enable();
    this.toggleUpdateOffhand();
  }

  async lookAtTarget() {
    if (!this.target) return;

    if (this.isPathing) return;

    if (this.placing) return;

    if (this.#eatingGap) return;

    const currentPosition = this.#bot.entity.position;
    const dx = this.target.position.x - currentPosition.x;
    const dz = this.target.position.z - currentPosition.z;

    const yaw = Math.atan2(-dx, -dz);

    // this.#bot.look(yaw, 0, true);

    this.#bot.look(yaw, 0, true);
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

    return bestObi; // Returns the best obsidian block for max damage
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
      calculateDistanceInBox(this.#bot.entity.position, this.target.position) <=
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
    } finally {
      this.toggleUpdateMainHand();
      this.placing = false;
    }
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

  stop() {
    // this.ffaToggle = false;
    this.trackToggle = false;
    this.target = null;
    this.possibleTargets.clear();
    this.#bot.clearControlStates();
  }
}

module.exports = AshPvP;
