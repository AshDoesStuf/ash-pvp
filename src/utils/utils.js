const { Vec3 } = require("vec3");
const speeds = require("./speeds.json");

function calculateDistanceInBox(currentPosition, targetPosition) {
  const distanceX = Math.abs(currentPosition.x - targetPosition.x);
  const distanceZ = Math.abs(currentPosition.z - targetPosition.z);

  const distanceBox = distanceX + distanceZ;

  return distanceBox;
}

function calculate3DDistance(currentPosition, targetPosition) {
  const dx = currentPosition.x - targetPosition.x;
  const dy = currentPosition.y - targetPosition.y;
  const dz = currentPosition.z - targetPosition.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
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

/**
 *
 * @param {import("mineflayer").Bot} bot
 * @param {string} blockName
 * @param {Vec3} targetPosition
 * @param {boolean} [placeBottom]
 * @returns
 */
async function placeBlock(bot, blockName, targetPosition, placeBottom = false) {
  return new Promise(async (resolve, reject) => {
    const item = bot.inventory.items().find((i) => i.name === blockName);
    if (!item) {
      return reject(`❌ Bot does not have ${blockName}!`);
    }

    const blockBelow = bot.blockAt(targetPosition.offset(0, -1, 0));
    if (!blockBelow || !blockBelow.boundingBox === "solid") {
      return reject("❌ Cannot place block: No solid surface below!");
    }

    await bot.equip(item, "hand");

    // Find a valid placement face
    const faces = [
      { face: 1, offset: new Vec3(0, 1, 0) }, // Top
      { face: 0, offset: new Vec3(0, -1, 0) }, // Bottom
      { face: 3, offset: new Vec3(0, 0, 1) }, // North
      { face: 2, offset: new Vec3(0, 0, -1) }, // South
      { face: 5, offset: new Vec3(1, 0, 0) }, // East
      { face: 4, offset: new Vec3(-1, 0, 0) }, // West
    ];

    let placeFace = faces.find((face) =>
      bot.blockAt(targetPosition.plus(face.offset))
    );
    if (!placeFace) {
      return reject("❌ No valid placement face found!");
    }

    // Look at the block before placing
    await bot.lookAt(targetPosition.offset(0.5, 0.5, 0.5), true);

    // Send the block place packet
    bot._client.write("block_place", {
      location: placeBottom
        ? targetPosition.floored().offset(0, -1, 0)
        : targetPosition,
      direction: placeFace.face,
      hand: 0, // Main hand
      cursorX: 0.5,
      cursorY: 0.5,
      cursorZ: 0.5,
    });

    resolve(`✅ Placed ${blockName} at ${targetPosition}`);
  });
}

module.exports = {
  calculateDistanceInBox,
  between,
  getSpeed,
  getItemEnchantments,
  getRandomInRange,
  placeBlock,
  calculate3DDistance,
};
