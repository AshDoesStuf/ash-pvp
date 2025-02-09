const { calculateDistanceInBox } = require("./utils/utils");

const Vec3 = require("vec3").Vec3;

class Node {
  constructor(x, y, z, g, h, parent = null) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.g = g; // Cost from start
    this.h = h; // Heuristic cost to goal
    this.f = g + h; // Total cost
    this.parent = parent;
  }
}

function heuristic(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z); // Manhattan Distance
}

function getNeighbors(node, bot) {
  const neighbors = [];
  const directions = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
    { x: 1, y: 0, z: 1 },
    { x: -1, y: 0, z: -1 },
    { x: 1, y: 0, z: -1 },
    { x: -1, y: 0, z: 1 },
  ];

  for (const dir of directions) {
    const newX = node.x + dir.x;
    const newY = node.y;
    const newZ = node.z + dir.z;

    const groundBlock = bot.blockAt(new Vec3(newX, newY - 1, newZ));
    const walkableBlock = bot.blockAt(new Vec3(newX, newY, newZ));
    const headBlock = bot.blockAt(new Vec3(newX, newY + 1, newZ));

    // Normal movement (flat ground)
    if (
      groundBlock &&
      groundBlock.boundingBox !== "empty" &&
      walkableBlock.boundingBox === "empty"
    ) {
      neighbors.push(new Node(newX, newY, newZ, 0, 0, node));
    }

    // Check for 1-block elevation climb
    const upperWalkableBlock = bot.blockAt(new Vec3(newX, newY + 1, newZ));
    const upperHeadBlock = bot.blockAt(new Vec3(newX, newY + 1, newZ));

    if (
      groundBlock &&
      groundBlock.boundingBox !== "empty" && // Solid ground to jump from
      walkableBlock.boundingBox !== "empty" && // Not walkable at current height
      upperWalkableBlock.boundingBox === "empty" && // Walkable at +1 height
      upperHeadBlock.boundingBox === "empty" // No head obstruction
    ) {
      neighbors.push(new Node(newX, newY + 1, newZ, 0, 0, node)); // Move up
    }
  }

  return neighbors;
}

function aStar(bot, startPos, targetPos) {
  startPos = startPos.floored().offset(0.5, 0, 0.5);
  targetPos = targetPos.floored().offset(0.5, 0, 0.5);
  const openSet = [
    new Node(
      startPos.x,
      startPos.y,
      startPos.z,
      0,
      heuristic(startPos, targetPos)
    ),
  ];
  const closedSet = new Set();

  while (openSet.length > 0) {
    openSet.sort((a, b) => a.f - b.f);
    let current = openSet.shift();

    if (
      calculateDistanceInBox(current, targetPos) <= 2
    ) {
      
      let path = [];
      while (current) {
        path.push({ x: current.x, y: current.y, z: current.z });
        current = current.parent;
      }
      // console.log(path)
      return path.reverse();
    }

    closedSet.add(`${current.x},${current.y},${current.z}`);

    for (const neighbor of getNeighbors(current, bot)) {
      if (closedSet.has(`${neighbor.x},${neighbor.y},${neighbor.z}`)) continue;

      neighbor.g = current.g + 1;
      neighbor.h = heuristic(neighbor, targetPos);
      neighbor.f = neighbor.g + neighbor.h;

      const existingNode = openSet.find(
        (n) => n.x === neighbor.x && n.y === neighbor.y && n.z === neighbor.z
      );
      if (!existingNode || neighbor.g < existingNode.g) {
        openSet.push(neighbor);
      }
    }
  }

  return null; // No path found
}

module.exports = aStar;
