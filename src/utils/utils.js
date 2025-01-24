const speeds = require("./speeds.json");
function calculateDistanceInBox(currentPosition, targetPosition) {
  const distanceX = Math.abs(currentPosition.x - targetPosition.x);
  const distanceZ = Math.abs(currentPosition.z - targetPosition.z);

  const distanceBox = distanceX + distanceZ;

  return distanceBox;
}

function between(x, min, max) {
  return x >= min && x <= max;
}

function getSpeed(weaponName) {
  if (!weaponName) return speeds.other;

  return speeds[weaponName.name] || speeds.other;
}

function getItemEnchantments(item) {
  if (!item) return [];

  let enchantments = [];

  const itemEnchants = item?.nbt?.value?.Enchantments?.value?.value;

  if (itemEnchants == undefined) return [];

  for (const obj of itemEnchants) {
    const enchant = {
      name: obj.id.value,
      level: obj.lvl.value,
    };

    enchantments.push(enchant);
  }

  return enchantments;
}

/**
 * Generates a random number within a given range, including positive and negative values.
 * @param {number} min - The minimum value (inclusive).
 * @param {number} max - The maximum value (inclusive).
 * @returns {number} A random number between min and max.
 */
function getRandomInRange(min, max) {
  if (min > max) {
    throw new Error("Min must be less than or equal to max.");
  }
  return Math.random() * (max - min) + min;
}

module.exports = {
  calculateDistanceInBox,
  between,
  getSpeed,
  getItemEnchantments,
  getRandomInRange,
};
