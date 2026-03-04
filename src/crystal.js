const Vec3 = require("vec3").Vec3;
const { placeBlock } = require("./utils/utils.js");

const sleep = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const CRYSTAL_NAME = "end_crystal";

class CrystalPvP {
  /** @type {import("./pvp.js")} */ #ashPvP;
  /** @type {import("mineflayer").Bot} */ #bot;

  #debug = true;
  #busy = false;

  placingCrystal = false;

  // Face cycling — keyed by "x,y,z", value = timestamp last detonated from this block
  #faceLastUsed = new Map();

  constructor(ashPvP) {
    this.#ashPvP = ashPvP;
    this.#bot = ashPvP.bot;
  }

  get bot() {
    return this.#bot;
  }
  get ashPvP() {
    return this.#ashPvP;
  }

  // ---------------------------------------------------------------------------
  // Profile helpers — fall back to sane defaults if no profile set
  // ---------------------------------------------------------------------------

  get #p() {
    return this.#ashPvP.profile ?? defaultProfile;
  }

  // ---------------------------------------------------------------------------
  // Predictive position
  // Projects target position forward by lookaheadMs based on current velocity.
  // Explosion damage is calculated at feet, so we predict feet position.
  // ---------------------------------------------------------------------------

  #predictTargetPos(target) {
    const lookahead = this.#p.predictLookaheadMs() / 1000;
    return target.position.offset(
      target.velocity.x * lookahead,
      target.velocity.y * lookahead,
      target.velocity.z * lookahead,
    );
  }

  // ---------------------------------------------------------------------------
  // Crystal finder — uses predicted position + face cycling penalty
  // ---------------------------------------------------------------------------

  findBestCrystalNearTarget(target) {
    const bot = this.#bot;
    const opts = this.#ashPvP.options;
    const predicted = this.#predictTargetPos(target);

    const candidates = Object.values(bot.entities).filter(
      (e) =>
        e.name === CRYSTAL_NAME &&
        e.position.distanceTo(predicted) <= opts.crystalDistance + 1,
    );
    if (!candidates.length) return null;

    let best = null,
      bestScore = -Infinity;

    for (const crystal of candidates) {
      // Use predicted position for damage calc
      const targetDamage = bot.getExplosionDamages(
        { ...target, position: predicted },
        crystal.position,
        opts.crystalDistance,
        true,
      );
      const selfDamage = bot.getExplosionDamages(
        bot.entity,
        crystal.position,
        opts.crystalDistance,
        true,
      );

      const distToFeet = crystal.position.distanceTo(predicted);
      const proximityBonus = Math.max(
        0,
        (opts.crystalDistance - distToFeet) * 2,
      );

      const score = this.#debug
        ? targetDamage + proximityBonus
        : targetDamage + proximityBonus - selfDamage * 0.3;

      if (score > bestScore) {
        bestScore = score;
        best = { crystal, targetDamage, selfDamage, score };
      }
    }

    return best;
  }

  // ---------------------------------------------------------------------------
  // Obi finder — proximity weight + face cycling cooldown penalty
  // ---------------------------------------------------------------------------

  findGoodObi() {
    const target = this.#ashPvP.target;
    const bot = this.#bot;
    if (!target) return null;

    const predicted = this.#predictTargetPos(target);
    const proxWeight = this.#p.proximityWeight();
    const faceCooldown = this.#p.faceCooldownMs();
    const now = Date.now();

    const nearbyObi = bot.findBlocks({
      matching: (b) =>
        b.name.includes("obsidian") || b.name.includes("bedrock"),
      maxDistance: this.#ashPvP.options.crystalDistance,
      point: target.position,
    });
    if (!nearbyObi.length) return null;

    const sorted = nearbyObi.sort(
      (a, b) => target.position.distanceTo(a) - target.position.distanceTo(b),
    );

    let bestObi = null,
      bestScore = -Infinity;

    for (const pos of sorted) {
      const crystalPos = pos.offset(0, 1, 0);
      const above1 = bot.blockAt(crystalPos);
      const above2 = bot.blockAt(crystalPos.offset(0, 1, 0));

      if (above1?.name !== "air" || above2?.name !== "air") continue;

      if (
        this.targetOccupiesBlock(crystalPos, target) ||
        this.targetOccupiesBlock(crystalPos.offset(0, 1, 0), target)
      )
        continue;

      if (
        bot.nearestEntity(
          (e) =>
            e.name === CRYSTAL_NAME && e.position.distanceTo(crystalPos) <= 2,
        )
      )
        continue;

      // Face cycling — penalize recently used faces instead of hard-skipping.
      // This lets a rusher reuse faces sooner, tactician rotates fully.
      const faceKey = `${pos.x},${pos.y},${pos.z}`;
      const lastUsed = this.#faceLastUsed.get(faceKey) ?? 0;
      const msSinceUse = now - lastUsed;
      // Penalty fades linearly over faceCooldownMs
      const facePenalty =
        msSinceUse < faceCooldown ? (1 - msSinceUse / faceCooldown) * 8 : 0;

      // Use predicted target position for damage
      const targetDamage = bot.getExplosionDamages(
        { ...target, position: predicted },
        crystalPos,
        this.#ashPvP.options.crystalDistance,
        true,
      );
      const selfDamage = bot.getExplosionDamages(
        bot.entity,
        crystalPos,
        this.#ashPvP.options.crystalDistance,
        true,
      );

      const distToTarget = predicted.distanceTo(pos);
      const proximityBonus = Math.max(0, (4 - distToTarget) * proxWeight);
      const score = this.#debug
        ? targetDamage + proximityBonus - facePenalty
        : targetDamage + proximityBonus - selfDamage * 0.5 - facePenalty;

      const selfOk = this.#debug || selfDamage < 10;
      if (targetDamage > 0 && selfOk && score > bestScore) {
        bestScore = score;
        bestObi = pos;
      }
    }

    if (this.#debug)
      console.log(
        bestObi
          ? `[Crystal] Best obi: ${bestObi} score=${bestScore.toFixed(2)}`
          : "[Crystal] No suitable obi found.",
      );

    return bestObi?.floored() ?? null;
  }

  // ---------------------------------------------------------------------------
  // Obsidian placement — uses predicted position + profile proximity weight
  // ---------------------------------------------------------------------------

  findGoodObsidianPlacement() {
    const bot = this.#bot;
    const target = this.#ashPvP.target;
    if (!target) return null;

    const predicted = this.#predictTargetPos(target);
    const proxWeight = this.#p.proximityWeight();
    const origin = target.position.floored().offset(0, -1, 0);

    const offsets = [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(0, 0, 0),
      new Vec3(1, 0, 1),
      new Vec3(-1, 0, -1),
      new Vec3(1, 0, -1),
      new Vec3(-1, 0, 1),
      new Vec3(2, 0, 0),
      new Vec3(-2, 0, 0),
      new Vec3(0, 0, 2),
      new Vec3(0, 0, -2),
      new Vec3(2, 0, 1),
      new Vec3(2, 0, -1),
      new Vec3(-2, 0, 1),
      new Vec3(-2, 0, -1),
      new Vec3(1, 0, 2),
      new Vec3(-1, 0, 2),
      new Vec3(1, 0, -2),
      new Vec3(-1, 0, -2),
      new Vec3(3, 0, 0),
      new Vec3(-3, 0, 0),
      new Vec3(0, 0, 3),
      new Vec3(0, 0, -3),
    ];

    let bestPos = null,
      bestScore = -Infinity;

    for (const offset of offsets) {
      const basePos = origin.plus(offset);
      const crystalPos = basePos.offset(0, 1, 0);
      const distToBot = bot.entity.position.distanceTo(crystalPos);

      if (distToBot > 4.5 || distToBot < 1.5) continue;

      const below = bot.blockAt(basePos);
      const up1 = bot.blockAt(crystalPos);
      const up2 = bot.blockAt(crystalPos.offset(0, 1, 0));

      if (!below || below.name === "air") continue;
      if (!up1 || up1.name !== "air") continue;
      if (!up2 || up2.name !== "air") continue;
      if (below.name.includes("obsidian") || below.name.includes("bedrock"))
        continue;
      if (this.targetOccupiesBlock(basePos, target)) continue;
      if (
        bot.nearestEntity(
          (e) =>
            e.name === CRYSTAL_NAME && e.position.distanceTo(crystalPos) <= 2,
        )
      )
        continue;

      const distToTarget = predicted.distanceTo(crystalPos);
      const targetDamage = bot.getExplosionDamages(
        { ...target, position: predicted },
        crystalPos,
        this.#ashPvP.options.crystalDistance,
        true,
      );
      const selfDamage = bot.getExplosionDamages(
        bot.entity,
        crystalPos,
        this.#ashPvP.options.crystalDistance,
        true,
      );

      const proximityBonus = Math.max(0, (4 - distToTarget) * proxWeight);
      const score = this.#debug
        ? targetDamage * 1.5 + proximityBonus
        : targetDamage * 1.5 +
          proximityBonus -
          selfDamage * 1.5 -
          distToBot * 0.2;

      const selfOk = this.#debug || score > 0;
      if (selfOk && score > bestScore) {
        bestScore = score;
        bestPos = basePos;
      }
    }

    return bestPos;
  }

  // ---------------------------------------------------------------------------
  // Hit → detonate with profile-driven timing
  // ---------------------------------------------------------------------------

  async hitThenDetonate(crystal, target) {
    if (this.#busy) return;
    this.#busy = true;

    try {
      const dist = this.#bot.entity.position.distanceTo(target.position);
      const inMelee = dist <= this.#ashPvP.options.maxAttackDist + 0.5;

      if (inMelee) {
        await this.#bot.lookAt(target.position.offset(0, 1.6, 0), true);
        this.#bot.attack(target);
        const delay = this.#p.hitToDetonateMs();
        if (this.#debug)
          console.log(`[Crystal] Hit, detonating in ${delay.toFixed(0)}ms...`);
        await sleep(delay);
      }

      if (!this.#bot.entities[crystal.id]) {
        if (this.#debug)
          console.log("[Crystal] Crystal gone before detonation.");
        return;
      }

      // Record face use for cycling
      const obiPos = crystal.position.offset(0, -1, 0).floored();
      this.#faceLastUsed.set(`${obiPos.x},${obiPos.y},${obiPos.z}`, Date.now());

      await this.#bot.lookAt(crystal.position, true);
      this.#bot.setControlState("jump", false);
      this.#bot.attack(crystal);
      if (this.#debug) console.log("[Crystal] Detonated!");
    } finally {
      this.#busy = false;
      this.placingCrystal = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Place crystal then hit→detonate
  // ---------------------------------------------------------------------------

  async placeCrystal(obiPos, target) {
    if (!this.hasEndCrystals() || this.#busy) return;

    this.#busy = true;
    this.placingCrystal = true;
    this.#ashPvP.toggleUpdateMainHand();

    try {
      const crystal = this.#bot.inventory
        .items()
        .find((i) => i.name === "end_crystal");
      await this.#bot.equip(crystal, "hand");
      await this.#bot.lookAt(obiPos.offset(0.5, 1, 0.5), true);
      await placeBlock(this.#bot, "end_crystal", obiPos, false);

      await sleep(50);

      const crystalPos = obiPos.offset(0, 1, 0);
      const placed = this.#bot.nearestEntity(
        (e) =>
          e.name === CRYSTAL_NAME && e.position.distanceTo(crystalPos) <= 2,
      );
      if (!placed) {
        if (this.#debug) console.log("[Crystal] Crystal didn't spawn.");
        return;
      }

      const predicted = this.#predictTargetPos(target);
      const targetDamage = this.#bot.getExplosionDamages(
        { ...target, position: predicted },
        placed.position,
        this.#ashPvP.options.crystalDistance,
        true,
      );
      const selfDamage = this.#bot.getExplosionDamages(
        this.#bot.entity,
        placed.position,
        this.#ashPvP.options.crystalDistance,
        true,
      );

      if (this.#debug)
        console.log(
          `[Crystal] Placed. tDmg=${(targetDamage / 2).toFixed(1)}♥ sDmg=${(selfDamage / 2).toFixed(1)}♥`,
        );

      if (this.shouldDetonate(targetDamage, selfDamage)) {
        await this.hitThenDetonate(placed, target);
      }
    } finally {
      this.placingCrystal = false;
      this.#busy = false;
      this.#ashPvP.toggleUpdateMainHand();
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async placeObsidian(pos) {
    const obsidian = this.#bot.inventory
      .items()
      .find((i) => i.name === "obsidian");
    if (!obsidian) return;
    await this.#bot.lookAt(pos.offset(0.5, 1, 0.5), true);
    await this.#bot.equip(obsidian, "hand");
    await this.#bot
      .placeBlock(this.#bot.blockAt(pos), new Vec3(0, 1, 0))
      .catch((err) => {
        console.log("[Crystal] Failed to place obsidian:", err.message);
      });
  }

  hasEndCrystals() {
    return this.#bot.inventory.items().some((i) => i.name === "end_crystal");
  }

  hasObsidian() {
    return this.#bot.inventory.items().some((i) => i.name === "obsidian");
  }

  shouldDetonate(targetDamage, selfDamage) {
    if (this.#debug) return targetDamage > 0;
    const botHealth = this.#bot.health * 2;
    const tolerance = this.#p.selfDamageTolerance();
    if (selfDamage >= botHealth * tolerance) return false;
    return targetDamage > 0;
  }

  targetOccupiesBlock(blockPos, target) {
    const p = target.position;
    const hw = 0.3;
    const bx = Math.floor(blockPos.x);
    const by = Math.floor(blockPos.y);
    const bz = Math.floor(blockPos.z);
    return (
      p.x + hw > bx &&
      p.x - hw < bx + 1 &&
      p.y + 1.8 > by &&
      p.y < by + 1 &&
      p.z + hw > bz &&
      p.z - hw < bz + 1
    );
  }
}

// Fallback if no profile has been applied
const defaultProfile = {
  hitToDetonateMs: () => 100,
  faceCooldownMs: () => 1500,
  proximityWeight: () => 3.0,
  selfDamageTolerance: () => 0.6,
  retreatDurationMs: () => 500,
  retreatBlocks: () => 2.0,
  predictLookaheadMs: () => 150,
  idealMinDist: 2.5,
  idealMaxDist: 4.0,
  strafeDurMs: () => 1200,
};

module.exports = CrystalPvP;
