/**
 * CombatAwareness — tracks incoming damage rate, target health, and
 * active effect windows so the FSM can make smarter heal/pearl decisions.
 *
 * Attach one instance to ashPvP and call update(dt) each tick.
 */
class CombatAwareness {
  // Rolling window of health samples (each: { health, time })
  #healthSamples = [];
  #SAMPLE_WINDOW_MS = 2500; // how far back we look for damage rate

  // Last known health — used to detect hits
  #lastHealth = 20;

  // Absorption tracking — gap gives 4 absorption (regular) or 16 (notch)
  // We track it via bot.entity.absorptionAmount if available, else estimate
  #lastAbsorption = 0;

  // Timestamp when last gap was consumed — used for regen window
  #lastGapAt = 0;
  #REGEN_WINDOW_MS = 5000; // regen lasts ~5s for regular gap

  /** @param {import("mineflayer").Bot} bot */
  constructor(bot) {
    this.bot = bot;
    this.#lastHealth = bot.health ?? 20;
  }

  // ---------------------------------------------------------------------------
  // Called every tick from updateTick()
  // ---------------------------------------------------------------------------
  update(dt) {
    const bot = this.bot;
    const now = Date.now();
    const health = bot.health ?? 20;

    // Record sample
    this.#healthSamples.push({ health, time: now });

    // Prune old samples outside our window
    const cutoff = now - this.#SAMPLE_WINDOW_MS;
    this.#healthSamples = this.#healthSamples.filter((s) => s.time >= cutoff);

    this.#lastHealth = health;
  }

  // ---------------------------------------------------------------------------
  // Damage rate — health lost per second over the last SAMPLE_WINDOW_MS.
  // Positive = taking damage, 0 or negative = stable/healing.
  // ---------------------------------------------------------------------------
  get incomingDPS() {
    if (this.#healthSamples.length < 2) return 0;
    const oldest = this.#healthSamples[0];
    const latest = this.#healthSamples[this.#healthSamples.length - 1];
    const dt = (latest.time - oldest.time) / 1000;
    if (dt < 0.1) return 0;
    const lost = oldest.health - latest.health; // positive = took damage
    return Math.max(0, lost / dt);
  }

  // ---------------------------------------------------------------------------
  // Absorption — check bot.absorptionAmount if exposed, else 0
  // ---------------------------------------------------------------------------
  get absorptionAmount() {
    return this.bot.entity?.absorptionAmount ?? 0;
  }

  get hasActiveAbsorption() {
    return this.absorptionAmount > 0;
  }

  // ---------------------------------------------------------------------------
  // Regen window — true if a gap was eaten recently and regen is likely active
  // ---------------------------------------------------------------------------
  get regenActive() {
    return Date.now() - this.#lastGapAt < this.#REGEN_WINDOW_MS;
  }

  /** Call this when a gap is successfully consumed */
  notifyGapConsumed() {
    this.#lastGapAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Target health helpers
  // ---------------------------------------------------------------------------

  /** Returns 0-20 health of the current target, or null if unknown */
  targetHealth(target) {
    return target?.health ?? null;
  }

  targetIsLow(target, threshold = 6) {
    const h = this.targetHealth(target);
    return h !== null && h <= threshold;
  }

  // ---------------------------------------------------------------------------
  // Gap selection — returns the best gap item to eat given the situation.
  // Notch apples are saved for emergencies (health ≤ 6 or DPS > 4/s).
  // Regular gaps are used for normal healing windows.
  // ---------------------------------------------------------------------------
  selectGap(bot, emergencyMode = false) {
    const items = bot.inventory.slots.filter((i) =>
      i?.name?.includes("golden_apple"),
    );
    if (!items.length) return null;

    const notch = items.find((i) => i.name === "enchanted_golden_apple");
    const regular = items.find((i) => i.name === "golden_apple");

    // Use notch apple only if it's an emergency — otherwise save it
    if (emergencyMode && notch) return notch;
    if (regular) return regular;
    // Only notch apples left — use them even in non-emergency
    return notch ?? null;
  }

  // ---------------------------------------------------------------------------
  // Estimate how many clean hits it would take to kill the target.
  // Uses the bot's held item damage + sharpness enchant if available.
  // Returns Infinity if no weapon or target health is unknown.
  // ---------------------------------------------------------------------------
  // Estimate damage per hit from an item (works for bot's held item or
  // target's equipment slot). Pass the item object or null for fist.
  #weaponDamage(item) {
    if (!item) return 1; // fist
    let base = 1;
    const name = item.name ?? "";
    if (name.includes("netherite_sword")) base = 8;
    else if (name.includes("diamond_sword")) base = 7;
    else if (name.includes("iron_sword")) base = 6;
    else if (name.includes("stone_sword")) base = 5;
    else if (name.includes("wooden_sword") || name.includes("gold_sword"))
      base = 4;
    else if (name.includes("netherite_axe")) base = 10;
    else if (name.includes("diamond_axe")) base = 9;
    else if (name.includes("iron_axe")) base = 9;
    else if (name.includes("stone_axe")) base = 9;

    // Add sharpness
    const enchants = item.nbt?.value?.Enchantments?.value?.value ?? [];
    for (const e of enchants) {
      const id = e?.id?.value ?? "";
      if (id.includes("sharpness")) {
        const lvl = e?.lvl?.value ?? 0;
        base += 0.5 * lvl + 0.5;
      }
    }
    return base;
  }

  // How many hits does the bot need to kill the target?
  estimatedHitsToKill(bot, target) {
    if (!target) return Infinity;
    const targetHp = target.health ?? target.metadata?.[9];
    if (targetHp == null || targetHp <= 0) return Infinity;
    return Math.ceil(targetHp / this.#weaponDamage(bot.heldItem));
  }

  // How many hits can the target land before the bot dies?
  // Uses target's held item via their equipment array (slot 0 = mainhand).
  estimatedHitsToBeKilled(bot, target, botHealth) {
    if (!target) return Infinity;
    const hp = botHealth ?? bot.health ?? 20;
    if (hp <= 0) return 0;

    // prismarine-entity exposes equipment[0] as mainhand
    const targetWeapon = target.equipment?.[0] ?? null;
    const dmg = this.#weaponDamage(targetWeapon);
    return Math.ceil(hp / dmg);
  }

  // True if committing to the fight is a winning trade:
  // bot kills target before or at the same tick the target kills the bot,
  // with a required margin so we don't trade lives unnecessarily.
  isWinningTrade(bot, target, botHealth, marginHits = 1) {
    const weKill = this.estimatedHitsToKill(bot, target);
    const theyKill = this.estimatedHitsToBeKilled(bot, target, botHealth);
    // We need to kill them strictly faster than they kill us (plus margin)
    return weKill + marginHits <= theyKill;
  }

  // ---------------------------------------------------------------------------
  // Master "should eat now?" decision
  // Returns: "EAT" | "WAIT" | "SKIP"
  //   EAT   = eat right now
  //   WAIT  = conditions not right yet (target too close, regen active, etc.)
  //   SKIP  = don't eat at all (target dying, absorption still up, etc.)
  // ---------------------------------------------------------------------------
  shouldEat(bot, target, health) {
    // Never eat if absorption from a previous gap is still active
    if (this.hasActiveAbsorption) return "SKIP";

    // Only skip eating if it's genuinely a winning trade to keep fighting:
    // - we can finish them in ≤2 hits AND
    // - we survive long enough to land those hits (they need more hits to kill us)
    // Without the mutual check the bot was charging in suicidally whenever the
    // target was low, ignoring that the target could still kill it first.
    if (this.isWinningTrade(bot, target, health, 1)) return "SKIP";

    // Skip if regen from previous gap is still running and health is OK
    if (this.regenActive && health >= 12) return "SKIP";

    // Not low enough to bother
    if (health > 15) return "SKIP";

    // Target is too close — we'd get hit mid-eat and cancel the animation.
    // Wait until we have some space.
    if (target) {
      const dist = bot.entity.position.distanceTo(target.position);
      if (dist < 4) return "WAIT";
    }

    return "EAT";
  }

  // ---------------------------------------------------------------------------
  // Master "should pearl?" decision
  // minSafeHealth = the caller's threshold — must be high enough to survive
  // worst-case pearl fall damage (base 5hp + up to 3hp drop damage = 8hp min,
  // we use 10 for a safe margin).
  // ---------------------------------------------------------------------------
  shouldPearl(bot, target, health, minSafeHealth = 10) {
    // Don't pearl if it's a winning trade — finish the fight
    if (this.isWinningTrade(bot, target, health, 1)) return false;

    // Critical safety gate: never pearl if health is too low to survive the
    // fall damage. This is what was killing the bot before — pearl always
    // deals fall damage on landing regardless of height.
    if (health <= minSafeHealth) return false;

    // Don't pearl if incoming damage rate is low and health is decent —
    // not actually in danger, save the pearl
    if (this.incomingDPS < 1.5 && health > minSafeHealth + 2) return false;

    return true;
  }
}

module.exports = CombatAwareness;
