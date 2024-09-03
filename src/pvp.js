const Entity = require("prismarine-entity").Entity;

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
} = require("./utils/utils.js");

class AshPvP extends EventEmitter {
  /**
   * @type {import("mineflayer").Bot}
   */
  #bot;

  #wtapping = false;

  #clostToTarget = false;

  #eatingGap = false;

  constructor(bot) {
    super();
    this.#bot = bot;

    this.options = {
      /**
       * The minimum attack distance/reach
       */
      minAttackDist: 0,
      /**
       * The maximum attack distance/reach
       */
      maxAttackDist: 2.9,
      /**
       * The max range for following untill we can use pathfinder
       */
      maxFollowRange: 15,
    };

    /**
     * The target we are currently attack. This is set by attack
     *
     * @type {Entity | null}
     */
    this.target = null;
    this.lastAttackTime = 0;
    this.isAttacking = false;

    this.strafeDuration = 2500;
    this.lastStrafeChangeTime = Date.now();
    this.currentStrafeDirection = "left";

    this.lastWTtapTime = 0;

    this.heldItemCooldown = this.calculateHeldItemCooldown();

    this.updateTick = this.updateTick.bind(this);
    this.stop = this.stop.bind(this);

    this.#bot.on("physicsTick", this.updateTick);
    this.#bot.on("death", this.stop);
  }

  /**
   *
   * @param {Entity} target The entity you want to attack
   */
  attack(target) {
    if (!target) return;

    console.log(target.username);

    this.target = target;
  }

  attackTick() {
    if (!this.target || this.isAttacking) return;

    const currentTime = Date.now();
    const timeSinceLastAttack = currentTime - this.lastAttackTime;

    if (timeSinceLastAttack >= this.heldItemCooldown) {
      this.lastAttackTime = currentTime;
      this.isAttacking = true;

      const currentPosition = this.#bot.entity.position;
      const targetPosition = this.target.position;

      const distance = calculateDistanceInBox(currentPosition, targetPosition);
      if (
        between(
          distance,
          this.options.minAttackDist,
          this.options.maxAttackDist
        ) &&
        !this.#eatingGap
      ) {
        this.#clostToTarget = true;
        this.#performAttack();
      } else this.#clostToTarget = false;

      // After the cooldown, reset the attack flag
      setTimeout(() => {
        this.isAttacking = false;
      }, this.heldItemCooldown);
    }
  }

  #performAttack() {
    this.#bot.attack(this.target);
    this.#wtap();
    this.emit("hit");
  }

  #wtap() {
    this.#wtapping = true;
    this.#bot.setControlState("sprint", false);
    this.#bot.setControlState("forward", false);

    setTimeout(() => {
      this.#bot.setControlState("sprint", true);
      this.#bot.setControlState("forward", true);
      this.#wtapping = false;
    }, 100);
  }

  /**
   * Runs every tick
   */
  updateTick() {
    this.heldItemCooldown = this.calculateHeldItemCooldown();
    this.lookAtTarget();
    this.attackTick();
    this.followTarget();
    this.equip();
    this.updateMainHand();
    this.updateOffhand();
    this.eatGap();
  }

  followTarget() {
    if (!this.target) return;

    const currentPosition = this.#bot.entity.position;
    const targetPosition = this.target.position;

    const distance = calculateDistanceInBox(currentPosition, targetPosition);

    if (distance > this.options.maxFollowRange) return;

    if (distance <= 1.6) {
      this.#bot.setControlState("forward", false);
      return;
    }

    if (!this.#wtapping) {
      this.#bot.setControlState("forward", true);
      this.#bot.setControlState("sprint", true);

      // if (this.#clostToTarget) {
      //   const currentTime = Date.now();

      //   if (currentTime - this.lastStrafeChangeTime >= this.strafeDuration) {
      //     this.#toggleStrafeDirection();
      //     this.lastStrafeChangeTime = currentTime;
      //   }

      //   if (this.currentStrafeDirection === "left") {
      //     this.#bot.setControlState("left", true);
      //     this.#bot.setControlState("right", false);
      //   } else {
      //     this.#bot.setControlState("left", false);
      //     this.#bot.setControlState("right", true);
      //   }
      // } else {
      //   this.#bot.setControlState("left", false);
      //   this.#bot.setControlState("right", false);
      // }
    }
  }

  async eatGap() {
    const health = this.#bot.health;

    if (health > 15) return;

    const gap = this.#bot.inventory.slots.find(
      (item) => item !== null && item.name.includes("golden_apple")
    );

    if (!gap) return;
    const ofhandslot = this.#bot.getEquipmentDestSlot("off-hand");
    let offhand =
      this.#bot.inventory.slots[ofhandslot] !== null &&
      this.#bot.inventory.slots[ofhandslot].name.includes("golden_apple");

    // effect object with the key being the effect's id
    const effects = this.#bot.entity.effects;

    // if we have regen then return
    if (effects["10"]) return;

    if (this.#eatingGap) return;

    if (offhand) {
      this.#eatingGap = true;
      this.#bot.activateItem(true);
      await sleep(1601);
      this.#bot.deactivateItem(true);
      this.#eatingGap = false;
    } else {
      this.#eatingGap = true;
      await this.#bot.equip(gap);
      this.#bot.activateItem();
      await sleep(1601);
      this.#bot.deactivateItem();
      this.#eatingGap = false;
    }
  }

  #toggleStrafeDirection() {
    // Toggle between "left" and "right"
    this.currentStrafeDirection =
      this.currentStrafeDirection === "left" ? "right" : "left";
  }

  lookAtTarget() {
    if (!this.target) return;

    const currentPosition = this.#bot.entity.position;
    const dx = this.target.position.x - currentPosition.x;
    const dz = this.target.position.z - currentPosition.z;

    const yaw = Math.atan2(-dx, -dz);

    this.#bot.look(yaw, 0);
  }

  calculateHeldItemCooldown() {
    const heldItem = this.#bot.heldItem;

    if (!heldItem) return 1;

    const seconds = getSpeed(heldItem);
    const cooldown = Math.floor((1 / seconds) * 1000);

    return cooldown - 5;
  }

  async equip() {
    const bot = this.#bot;

    const getBestArmor = (type) => {
      const equipmentSlot = bot.getEquipmentDestSlot(type);
      const currentArmor = bot.inventory.slots[equipmentSlot];

      let bestArmor = null;

      for (const item of bot.inventory.items()) {
        if (armorMap[item.name.toLowerCase()] !== type) continue;

        const itemPoints = armorPointsMap[item.name.toLowerCase()] || 0;
        const currentPoints =
          armorPointsMap[currentArmor?.name?.toLowerCase()] || 0;

        if (!bestArmor || itemPoints > currentPoints) {
          bestArmor = item;
        }
      }

      if (
        bestArmor &&
        (!currentArmor ||
          armorPointsMap[bestArmor.name.toLowerCase()] >
            armorPointsMap[currentArmor.name.toLowerCase()])
      ) {
        return bestArmor;
      }

      return null;
    };

    const helmet = getBestArmor("head");
    const chest = getBestArmor("torso");
    const leg = getBestArmor("legs");
    const boot = getBestArmor("feet");

    if (helmet) {
      await bot.equip(helmet, "head");
    }

    if (chest) {
      await bot.equip(chest, "torso");
    }

    if (leg) {
      await bot.equip(leg, "legs");
    }

    if (boot) {
      await bot.equip(boot, "feet");
    }
  }

  async updateMainHand() {
    const bot = this.#bot;
    // Loop through bots inventory
    // check if the item is a sword
    // check if that item has a higher damage than its friends
    // equip that item
    let unsortedItems = bot.inventory
      .items()
      .filter((item) => item.name.includes("sword"));

    const getItemTotalDamage = (item) => {
      let totalDamage = weaponBase[item.name] || 0;
      const enchantments = getItemEnchantments(item);

      for (const enchantment of enchantments) {
        if (enchantment.name.split(":")[1] === "sharpness") {
          const enchantDamage = 0.5 * enchantment.level + 0.5;
          totalDamage += enchantDamage;
        }
      }

      return totalDamage;
    };

    const sortedItems = unsortedItems.slice().sort((itemA, itemB) => {
      const damageA = getItemTotalDamage(itemA);
      const damageB = getItemTotalDamage(itemB);

      return damageB - damageA;
    });

    const bestSword = sortedItems[0];

    if (!bestSword) return;

    if (bot.heldItem && bot.heldItem.name.includes(bestSword.name)) return;

    await bot.equip(bestSword);
  }
  async updateOffhand() {
    if (this.#bot.supportFeature("doesntHaveOffHandSlot")) return;

    if (this.#eatingGap) return;

    const unsortedItems = this.#bot.inventory.slots.filter(
      (item) => item !== null && item.name in offhandPriority
    );

    const sortedItems = unsortedItems.sort((itemA, itemB) => {
      const itemAPoints = offhandPriority[itemA.name];
      const itemBPoints = offhandPriority[itemB.name];

      return itemBPoints - itemAPoints;
    });

    const bestItem = sortedItems.length > 0 ? sortedItems[0] : null;

    if (!bestItem) return;

    const offhandSlot = this.#bot.getEquipmentDestSlot("off-hand");
    const offHandItem = this.#bot.inventory.slots[offhandSlot];

    if (!this.#bot.inventory.items().includes(bestItem)) return;

    if (offHandItem && offHandItem.name === bestItem.name) return;

    await this.#bot.equip(bestItem, "off-hand");
  }

  stop() {
    this.target = null;
    this.#bot.clearControlStates();
  }
}

module.exports = AshPvP;
