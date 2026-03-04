/**
 * Personality profiles for AshPvP.
 *
 * Each profile is merged over the base options in pvp.js and adds
 * behavioral constants read by crystal.js and the FSM states.
 *
 * Usage:
 *   const { applyProfile } = require("./utils/profiles");
 *   applyProfile(this, "rusher");
 */

const PROFILES = {
  // -------------------------------------------------------------------------
  // RUSHER — gets in close fast, detonates aggressively, high self-damage tol
  // -------------------------------------------------------------------------
  rusher: {
    // PvP options
    crystalDistance: 5,
    minAttackDist: 1.5,
    maxAttackDist: 2.5,
    critChance: 0.6,

    // Crystal behavior
    hitToDetonateMs: 60, // hits and blows almost simultaneously
    faceCooldownMs: 800, // reuses obi faces quickly
    proximityWeight: 5.0, // heavily prefers dist=1 obi
    selfDamageTolerance: 0.9, // will eat up to 90% of bot health in self dmg
    retreatDurationMs: 300, // short retreat after detonation
    retreatBlocks: 1.5,
    predictLookaheadMs: 80, // short lookahead — relies on being close

    // Positioning
    idealMinDist: 1.8,
    idealMaxDist: 3.2,
    strafeDurMs: 800, // switches strafe direction rapidly
  },

  // -------------------------------------------------------------------------
  // TACTICIAN — surrounds target with obi first, waits for high-value shots
  // -------------------------------------------------------------------------
  tactician: {
    crystalDistance: 4,
    minAttackDist: 2.5,
    maxAttackDist: 3.5,
    critChance: 0.3,

    hitToDetonateMs: 130,
    faceCooldownMs: 2500, // waits longer before reusing a face
    proximityWeight: 2.0,
    selfDamageTolerance: 0.4,
    retreatDurationMs: 700,
    retreatBlocks: 3.0,
    predictLookaheadMs: 200, // longer lookahead — waits for target to move into position

    idealMinDist: 3.0,
    idealMaxDist: 4.5,
    strafeDurMs: 1800,
  },

  // -------------------------------------------------------------------------
  // CHAOTIC — unpredictable timing, unusual angles, hard to read
  // -------------------------------------------------------------------------
  chaotic: {
    crystalDistance: 4.5,
    minAttackDist: 1.8,
    maxAttackDist: 3.2,
    critChance: 0.45,

    hitToDetonateMs: () => 40 + Math.random() * 160, // 40–200ms randomly
    faceCooldownMs: () => 500 + Math.random() * 1500,
    proximityWeight: () => 1.5 + Math.random() * 4, // random weighting each check
    selfDamageTolerance: 0.65,
    retreatDurationMs: () => 200 + Math.random() * 600,
    retreatBlocks: () => 1.0 + Math.random() * 2.5,
    predictLookaheadMs: () => 50 + Math.random() * 250,

    idealMinDist: 2.2,
    idealMaxDist: 4.0,
    strafeDurMs: () => 600 + Math.random() * 1600,
  },

  // -------------------------------------------------------------------------
  // BALANCED — sensible defaults, close to original behavior
  // -------------------------------------------------------------------------
  balanced: {
    crystalDistance: 4,
    minAttackDist: 2,
    maxAttackDist: 2.8,
    critChance: 0.3,

    hitToDetonateMs: 100,
    faceCooldownMs: 1500,
    proximityWeight: 3.0,
    selfDamageTolerance: 0.6,
    retreatDurationMs: 500,
    retreatBlocks: 2.0,
    predictLookaheadMs: 150,

    idealMinDist: 2.5,
    idealMaxDist: 4.0,
    strafeDurMs: 1200,
  },
};

/**
 * Resolves a profile value — if it's a function (chaotic randomness), call it.
 * @param {*} val
 * @returns {number}
 */
function resolve(val) {
  return typeof val === "function" ? val() : val;
}

/**
 * Applies a named profile to an AshPvP instance.
 * Merges PvP options and attaches behavioral constants to instance.profile.
 * @param {import("../pvp.js")} ashPvP
 * @param {string} name
 */
function applyProfile(ashPvP, name = "balanced") {
  const profile = PROFILES[name];
  if (!profile) {
    console.warn(`[Profile] Unknown profile "${name}", using balanced.`);
    return applyProfile(ashPvP, "balanced");
  }

  // Merge PvP options
  const optionKeys = [
    "crystalDistance",
    "minAttackDist",
    "maxAttackDist",
    "critChance",
  ];
  for (const key of optionKeys) {
    if (profile[key] !== undefined) ashPvP.options[key] = resolve(profile[key]);
  }

  // Attach behavioral constants as ashPvP.profile — read by crystal.js + states
  ashPvP.profile = {
    name,
    hitToDetonateMs: () => resolve(profile.hitToDetonateMs ?? 100),
    faceCooldownMs: () => resolve(profile.faceCooldownMs ?? 1500),
    proximityWeight: () => resolve(profile.proximityWeight ?? 3.0),
    selfDamageTolerance: () => resolve(profile.selfDamageTolerance ?? 0.6),
    retreatDurationMs: () => resolve(profile.retreatDurationMs ?? 500),
    retreatBlocks: () => resolve(profile.retreatBlocks ?? 2.0),
    predictLookaheadMs: () => resolve(profile.predictLookaheadMs ?? 150),
    idealMinDist: resolve(profile.idealMinDist ?? 2.5),
    idealMaxDist: resolve(profile.idealMaxDist ?? 4.0),
    strafeDurMs: () => resolve(profile.strafeDurMs ?? 1200),
  };

  console.log(`[Profile] Applied "${name}" to ${ashPvP.bot.username}`);
}

module.exports = { applyProfile, PROFILES };
