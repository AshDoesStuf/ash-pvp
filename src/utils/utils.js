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
  if (!item) return []

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

module.exports = {
  calculateDistanceInBox,
  between,
  getSpeed,
  getItemEnchantments,
};
