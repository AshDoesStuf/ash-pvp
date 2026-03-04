const Vec3 = require("vec3").Vec3;
const EventEmitter = require("events");

const armorMap = require("./utils/armorMap.json");
const armorPointsMap = require("./utils/armorPoints.json");
const weaponBase = require("./utils/weaponBase.json");
const offhandPriority = require("./utils/offhandPriority.json");

const CrystalPvP = require("./crystal.js");
const { PvPStateMachine } = require("./PvPStateMachine");
const {
  IdleState,
  PathingState,
  CrystalPositionState,
  CrystalPlaceState,
  CrystalDetonateState,
  MeleeEngageState,
  EatingState,
  PearlingState,
  RangedState,
  RetreatingState,
  InterceptPearlState,
} = require("./states");
const { applyProfile, PROFILES } = require("./utils/profiles");
const CombatAwareness = require("./CombatAwareness");
const { Weapons } = require("minecrafthawkeye");

const sleep = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const {
  calculateDistanceInBox,
  getSpeed,
  getItemEnchantments,
  getRandomInRange,
  placeBlock,
  calculate3DDistance,
} = require("./utils/utils.js");

class AshPvP extends EventEmitter {
  /** @type {import("mineflayer").Bot} */
  #bot;

  #canUpdateMainHand = true;
  #canUpdateOffhand = true;
  #attackTask = null;
  #lastSelectedOffhand = null;

  constructor(bot, profileName = "balanced") {
    super();
    this.#bot = bot;

    this.running = false;
    this.lastUpdate = performance.now();
    this.combatEnabled = false;

    this.options = {
      minAttackDist: 2,
      maxAttackDist: 2.9,
      maxFollowRange: 2.9,
      targetSwitchInterval: 3500,
      critChance: 0,
      placeCooldown: 6700,
      crystalPvP: false,
      crystalDistance: 4,
      bowPvP: false,
    };

    /** @type {import("prismarine-entity").Entity} */
    this.target = null;
    this.lastAttackTime = 0;
    this.isAttacking = false;
    this.ffaToggle = false;
    this.ffaOptions = {};

    this.targetAcquiredAt = 0;
    this.heldItemCooldown = this.calculateHeldItemCooldown();

    this.teamates = [];
    this.possibleTargets = new Set();
    this.isNetherite = this.checkNetherite();

    // Obstacle placement (used by MeleeEngageState)
    this.canPlaceObstacle = false;
    this.placing = false;

    // Crystal PvP handler
    this.crystalPvP = new CrystalPvP(this);

    // Combat awareness tracker
    this.awareness = new CombatAwareness(bot);

    // FSM
    this.fsm = new PvPStateMachine(this);
    this.fsm.registerState("IDLE", new IdleState());
    this.fsm.registerState("PATHING", new PathingState());
    this.fsm.registerState("CRYSTAL_POSITION", new CrystalPositionState());
    this.fsm.registerState("CRYSTAL_PLACE", new CrystalPlaceState());
    this.fsm.registerState("CRYSTAL_DETONATE", new CrystalDetonateState());
    this.fsm.registerState("MELEE_ENGAGE", new MeleeEngageState());
    this.fsm.registerState("EATING", new EatingState());
    this.fsm.registerState("PEARLING", new PearlingState());
    this.fsm.registerState("INTERCEPT_PEARL", new InterceptPearlState());
    this.fsm.registerState("RANGED", new RangedState());
    this.fsm.registerState("RETREATING", new RetreatingState());

    // Team init
    (async () => {
      const teams = this.#bot.teamMap;
      const botTeam = teams[bot.username];
      if (!botTeam) return;
      for (const member of botTeam.members) {
        if (member !== this.#bot.username) this.teamates.push(member);
      }
    })();

    this.stop = this.stop.bind(this);
    this.#bot.on("death", this.stop);
    this.#bot.on("entityDead", (entity) => {
      if (this.target?.id === entity.id) {
        this.stop();
        this.emit("target-death", entity);
      }
    });

    applyProfile(this, profileName);
    this.fsm.start("IDLE");
    this.startUpdateLoop();
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  get bot() {
    return this.#bot;
  }

  get hasFullArmor() {
    const armor = this.#bot.armor();
    const missing = [];
    if (!armor.head) missing.push("head");
    if (!armor.torso) missing.push("torso");
    if (!armor.legs) missing.push("legs");
    if (!armor.feet) missing.push("feet");
    return { hasAll: missing.length === 0, missing };
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getCurrentSettings() {
    return this.options;
  }
  updateSettings(s) {
    Object.assign(this.options, s);
  }
  updateSetting(key, value) {
    if (Object.hasOwn(this.options, key)) this.options[key] = value;
    else console.error(`Setting ${key} does not exist.`);
  }

  // ---------------------------------------------------------------------------
  // Update loop
  // ---------------------------------------------------------------------------

  startUpdateLoop() {
    if (this.running) return;
    this.running = true;

    const update = () => {
      if (!this.running) return;
      const now = performance.now();
      const deltaTime = (now - this.lastUpdate) / 1000;
      this.lastUpdate = now;
      this.updateTick(deltaTime);
      setTimeout(update, 50);
    };

    update();
  }

  stopUpdateLoop() {
    this.running = false;
  }

  /** @param {number} deltaTime */
  updateTick(deltaTime) {
    this.heldItemCooldown = this.calculateHeldItemCooldown();
    this.updateTeamates();
    this.updateAttackTime(deltaTime);
    this.isNetherite = this.checkNetherite();
    this.awareness.update(deltaTime);
    this.equip();

    if (this.combatEnabled) {
      this.updateMainHand();
      this.updateOffhand();
      this.ffaTick();
      this.semiFfaTick();
      this.fsm.tick(deltaTime).catch((err) => {
        console.error("[AshPvP] FSM tick error:", err);
      });
    }
  }

  enableCombat() {
    this.combatEnabled = true;
  }
  disableCombat() {
    this.combatEnabled = false;
  }

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  stop(withFFA = true) {
    if (withFFA) this.ffaToggle = false;
    this.target = null;
    this.possibleTargets.clear();
    this.bot.clearControlStates();
    this.fsm.stop();
  }

  // ---------------------------------------------------------------------------
  // Target acquisition
  // ---------------------------------------------------------------------------

  attack(target) {
    if (!target) return Promise.reject(new Error("No target specified"));
    if (this.#attackTask) return;

    this.target = target;
    this.#attackTask = target;
    this.fsm.start("IDLE");
    this.emit("target-aquired", target);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.#bot.removeListener("entityDead", onDeath);
        this.#bot.removeListener("entityGone", onGone);
        this.#bot.removeListener("death", onError);
      };

      const onDeath = (entity) => {
        if (entity.id !== target.id) return;
        cleanup();
        this.possibleTargets.delete(target.id);
        this.#attackTask = null;
        this.target = null;
        this.bot.clearControlStates();
        this.stop(!this.ffaToggle);
        resolve();
      };

      const onGone = (entity) => {
        if (entity.id !== target.id) return;
        cleanup();
        this.possibleTargets.delete(target.id);
        this.#attackTask = null;
        this.target = null;
        this.bot.clearControlStates();

        this.stop(!this.ffaToggle);
        resolve();
      };

      const onError = () => {
        cleanup();
        this.#attackTask = null;
        this.target = null;
        this.bot.clearControlStates();
        reject("Bot died");
      };

      this.#bot.on("entityDead", onDeath);
      this.#bot.on("entityGone", onGone);
      this.#bot.on("death", onError);
    });
  }

  ffa(options = {}) {
    this.ffaToggle = !this.ffaToggle;
    this.ffaOptions = options;
  }

  async ffaTick() {
    if (!this.ffaToggle) return;
    if (this.target) {
      if (
        Date.now() - this.targetAcquiredAt <
        this.options.targetSwitchInterval
      )
        return;
      this.target = null;
      this.#attackTask = null;
    }
    const nearest = this.#bot.nearestEntity((e) => this.isValidTarget(e));
    if (!nearest) return;
    this.targetAcquiredAt = Date.now();
    try {
      await this.attack(nearest);
      await this.fsm.forceTransition("PATHING");
    } catch (e) {
      console.log("ffa error:", e);
    }
  }

  async semiFfaTick() {
    if (!this.possibleTargets.size) return;
    if (this.target) {
      if (
        Date.now() - this.targetAcquiredAt <
        this.options.targetSwitchInterval
      )
        return;
      this.target = null;
      this.#attackTask = null;
    }
    let closest = null,
      closestDist = Infinity;
    for (const id of this.possibleTargets) {
      const entity = this.#bot.entities[id];
      if (!entity) {
        this.possibleTargets.delete(id);
        continue;
      }
      const d = this.#bot.entity.position.distanceTo(entity.position);
      if (d < closestDist) {
        closest = entity;
        closestDist = d;
      }
    }
    if (closest) {
      this.targetAcquiredAt = Date.now();
      try {
        await this.attack(closest);
        await this.fsm.forceTransition("PATHING");
      } catch (e) {
        console.log(e);
      }
    }
  }

  async isValidTarget(entity) {
    if (!entity || entity.type !== "player") return false;
    if (this.teamates.includes(entity.username)) return false;
    if (this.#bot.hivemind?.kings?.includes(entity.username)) return false;
    if (
      this.ffaOptions &&
      !this.ffaOptions.ignoreBotmind &&
      this.#bot.hivemind?.connectedBots
        ?.map((b) => b.name)
        .includes(entity.username)
    )
      return false;
    if (entity.health <= 0) return false;
    return true;
  }

  async attackMobGroup(mobs) {
    mobs.sort(
      (a, b) =>
        a.position.distanceTo(this.#bot.entity.position) -
        b.position.distanceTo(this.#bot.entity.position),
    );
    const toAttack = mobs.filter(
      (m) => m.position.distanceTo(this.#bot.entity.position) <= 3,
    );
    await Promise.all(toAttack.map((m) => this.attack(m)));
    for (const m of toAttack) {
      const i = mobs.indexOf(m);
      if (i > -1) mobs.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Timing
  // ---------------------------------------------------------------------------

  updateAttackTime(dt) {
    if (this.target) this.lastAttackTime += dt * 1000;
  }

  // ---------------------------------------------------------------------------
  // Ranged (used by RangedState)
  // ---------------------------------------------------------------------------

  hasBow() {
    const items = this.#bot.inventory.items();
    return (
      items.some((i) => i.name === "bow") &&
      items.some((i) => i.name.includes("arrow"))
    );
  }

  async rangedAttack() {
    this.toggleUpdateMainHand();
    const bow = this.#bot.inventory.items().find((i) => i.name === "bow");
    if (!bow) {
      this.toggleUpdateMainHand();
      return;
    }
    await this.#bot.equip(bow, "hand");
    this.#bot.hawkEye.oneShot(this.target, Weapons.bow);
    this.toggleUpdateMainHand();
  }

  // ---------------------------------------------------------------------------
  // Obstacle placement (used by MeleeEngageState)
  // ---------------------------------------------------------------------------

  shouldPlaceObstacle() {
    if (!this.target) return false;
    const blockAt = this.#bot.blockAt(this.target.position);
    if (!blockAt || blockAt.name === "cobweb") return false;
    return true;
  }

  async placeObstacle() {
    if (!this.target || !this.canPlaceObstacle || !this.target.onGround) return;

    const items = ["flint_and_steel", "cobweb"]
      .map((n) => this.#bot.inventory.items().find((i) => i.name.includes(n)))
      .filter(Boolean);
    if (!items.length) return;

    const near =
      calculateDistanceInBox(this.#bot.entity.position, this.target.position) <
      4;
    if (!near) return;

    const blockUnder = this.#bot.blockAt(this.target.position.offset(0, -1, 0));
    if (blockUnder?.name === "cobweb") return;

    const item = items[Math.floor(Math.random() * items.length)];
    if (this.placing) return;

    this.toggleUpdateMainHand();
    this.placing = true;
    this.#bot.clearControlStates();

    try {
      await this.#bot.equip(item, "hand");
      await this.#bot.lookAt(this.target.position, true);

      const stationary =
        Math.abs(this.target.velocity.x) < 0.2 &&
        Math.abs(this.target.velocity.z) < 0.2;

      if (item.name.includes("flint_and_steel") && stationary) {
        await sleep(100);
        this.#bot.activateItem();
        await sleep(100);
        this.#bot.activateItem();
      } else if (item.name.includes("cobweb")) {
        await placeBlock(this.#bot, "cobweb", this.target.position);
      }
      await sleep(300);
    } catch (err) {
      console.log(err);
    } finally {
      this.toggleUpdateMainHand();
      this.placing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Pearl
  // ---------------------------------------------------------------------------

  async pearlAway() {
    const bot = this.#bot;
    const MAX_TRIES = 4;
    const FLEE_DIST_MIN = 8;
    const FLEE_DIST_MAX = 14;
    // How long to wait for forcedMove before giving up on this throw
    const TELEPORT_TIMEOUT_MS = 3000;

    const pearl = bot.inventory.items().find((i) => i.name === "ender_pearl");
    if (!pearl) return false;

    // Build candidate escape directions — bias away from target if we have one,
    // otherwise spread evenly across all 8 compass directions.
    const botPos = bot.entity.position;
    const targetPos = this.target?.position;

    const awayYaw = targetPos
      ? Math.atan2(botPos.x - targetPos.x, botPos.z - targetPos.z)
      : Math.random() * Math.PI * 2;

    // 8 directions spread around the away-vector (±157° arc behind us)
    const candidateYaws = [
      -Math.PI * 0.875,
      -Math.PI * 0.625,
      -Math.PI * 0.375,
      -Math.PI * 0.125,
      Math.PI * 0.125,
      Math.PI * 0.375,
      Math.PI * 0.625,
      Math.PI * 0.875,
    ].map((offset) => awayYaw + offset);

    // When health is low, restrict landings to same Y or higher to avoid
    // stacking fall damage on top of the base pearl damage (always 5hp).
    // At safe health, allow dropping up to 2 blocks for more landing options.
    const isLowHealth = bot.health <= 14;
    const maxDropBlocks = isLowHealth ? 0 : 2;

    // Find a safe landing block in a given horizontal direction
    const findLandingSpot = (yaw) => {
      for (let dist = FLEE_DIST_MAX; dist >= FLEE_DIST_MIN; dist -= 2) {
        const tx = Math.round(botPos.x + Math.sin(yaw) * dist);
        const tz = Math.round(botPos.z + Math.cos(yaw) * dist);

        // Scan +3 above to -maxDropBlocks below current Y.
        // Scanning upward first means we prefer elevated spots (no fall damage).
        for (let dy = 3; dy >= -maxDropBlocks; dy--) {
          const ground = bot.blockAt(
            new Vec3(tx, Math.floor(botPos.y) + dy, tz),
          );
          const foot = bot.blockAt(
            new Vec3(tx, Math.floor(botPos.y) + dy + 1, tz),
          );
          const head = bot.blockAt(
            new Vec3(tx, Math.floor(botPos.y) + dy + 2, tz),
          );

          if (!ground || !foot || !head) continue;

          const isSafe =
            ground.boundingBox === "block" &&
            foot.boundingBox === "empty" &&
            head.boundingBox === "empty" &&
            !ground.name.includes("lava") &&
            !ground.name.includes("magma") &&
            !foot.name.includes("lava") &&
            !foot.name.includes("fire");

          if (isSafe) return foot.position;
        }
      }
      return null;
    };

    // Try each candidate direction in order
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const yaw = candidateYaws[attempt % candidateYaws.length];
      const landingPos = findLandingSpot(yaw);
      if (!landingPos) continue;

      const shot = bot.hawkEye.getMasterGrade(
        { position: landingPos },
        new Vec3(0, 0.05, 0),
        "ender_pearl",
      );
      if (!shot) continue;

      try {
        await bot.equip(pearl, "hand");
        await bot.look(shot.yaw, shot.pitch, true);
        bot.activateItem(false);

        // Wait for teleport with a hard timeout — never hang forever
        await Promise.race([
          new Promise((r) => bot.once("forcedMove", r)),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error("teleport timeout")),
              TELEPORT_TIMEOUT_MS,
            ),
          ),
        ]);

        return true;
      } catch (err) {
        console.warn(
          `[pearlAway] attempt ${attempt + 1} failed: ${err.message}`,
        );
        await sleep(200);
      }
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Hand management
  // ---------------------------------------------------------------------------

  toggleUpdateMainHand() {
    this.#canUpdateMainHand = !this.#canUpdateMainHand;
  }
  toggleUpdateOffhand() {
    this.#canUpdateOffhand = !this.#canUpdateOffhand;
  }
  isMainHandLocked() {
    return !this.#canUpdateMainHand;
  }
  isOffhandLocked() {
    return !this.#canUpdateOffhand;
  }

  async updateMainHand() {
    if (!this.#canUpdateMainHand) return;
    if (this.placing || this.crystalPvP.placingCrystal) return;

    const bot = this.#bot;
    const weaponTypes = ["sword", "axe", "trident"];
    const weapons = bot.inventory
      .items()
      .filter((i) => weaponTypes.some((t) => i.name.includes(t)));
    if (!weapons.length) return;

    const getDamage = (item) => {
      let base = weaponBase[item.name] || 0;
      const spd = getSpeed(item.name) || 1.6;
      for (const ench of getItemEnchantments(item)) {
        if (ench.name.split(":")[1] === "sharpness")
          base += 0.5 * ench.level + 0.5;
      }
      return base * (spd / 4);
    };

    const best = weapons.slice().sort((a, b) => getDamage(b) - getDamage(a))[0];
    if (!best || bot.heldItem?.name === best.name) return;
    await bot.equip(best, "hand");
  }

  async updateOffhand() {
    if (!this.#canUpdateOffhand) return;
    if (this.#bot.supportFeature("doesntHaveOffHandSlot")) return;
    if (this.fsm.current === "EATING") return;
    if (this.#bot?.autoEat?.isEating) return;

    const valid = this.#bot.inventory.slots
      .filter((i) => i && offhandPriority[i.name] !== undefined)
      .sort((a, b) => offhandPriority[b.name] - offhandPriority[a.name]);

    const best =
      valid.find((i) => i.name === "totem_of_undying") ||
      valid.find((i) => i.name.includes("golden_apple")) ||
      valid[0];

    if (!best) return;

    const offSlot = this.#bot.getEquipmentDestSlot("off-hand");
    const current = this.#bot.inventory.slots[offSlot];
    if (current?.name === best.name) return;
    if (this.#lastSelectedOffhand === best.name) return;

    await this.#bot.equip(best, "off-hand");
    this.#lastSelectedOffhand = best.name;
  }

  // ---------------------------------------------------------------------------
  // Armor
  // ---------------------------------------------------------------------------

  async equip() {
    const bot = this.#bot;
    const getBest = (type) => {
      const slot = bot.getEquipmentDestSlot(type);
      const current = bot.inventory.slots[slot];
      return bot.inventory.items().reduce((best, item) => {
        if (armorMap[item.name.toLowerCase()] !== type) return best;
        const pts = armorPointsMap[item.name.toLowerCase()] || 0;
        const cur = armorPointsMap[current?.name?.toLowerCase()] || 0;
        return pts > cur ? item : best;
      }, null);
    };
    for (const type of ["head", "torso", "legs", "feet"]) {
      const best = getBest(type);
      if (best) {
        await bot.equip(best, type);
        await sleep(50);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------

  checkNetherite() {
    const bot = this.#bot;
    const slots = ["head", "torso", "legs", "feet"].map((t) =>
      bot.getEquipmentDestSlot(t),
    );
    return (
      slots.filter((s) => bot.inventory.slots[s]?.name?.includes("netherite"))
        .length >= 3
    );
  }

  updateTeamates() {
    const botTeam = this.#bot.teamMap?.[this.#bot.username];
    if (!botTeam) return;
    for (const m of botTeam.members) {
      if (m !== this.#bot.username && !this.teamates.includes(m))
        this.teamates.push(m);
    }
  }

  calculateHeldItemCooldown() {
    const item = this.#bot.heldItem;
    if (!item) return 1;
    const spd = getSpeed(item);
    return Math.floor((1 / spd) * 1000) - getRandomInRange(50, 100);
  }

  isPartOfTeam(entity) {
    return this.teamates.includes(entity.username);
  }
}

module.exports = AshPvP;
