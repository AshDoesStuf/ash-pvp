const { calculateDistanceInBox, calculate3DDistance } = require("./utils/utils");
const Vec3 = require("vec3").Vec3;

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------
class Node {
  constructor(x, y, z, g, h, parent = null) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.g = g;
    this.h = h;
    this.f = g + h;
    this.parent = parent;
  }
  get key() {
    return `${this.x},${this.y},${this.z}`;
  }
}

// ---------------------------------------------------------------------------
// Heuristic — weighted Manhattan (diagonal movement is ~1.414 not 1)
// ---------------------------------------------------------------------------
function heuristic(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const dz = Math.abs(a.z - b.z);
  // Octile distance: accounts for diagonal moves costing sqrt(2)
  const horiz = Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  return horiz + dy * 1.5; // vertical movement costs more
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------
function isSolid(block) {
  return block && block.boundingBox !== "empty";
}
function isPassable(block) {
  if (!block) return true; // unknown = assume passable
  if (block.boundingBox !== "empty") return false;
  // Treat dangerous blocks as impassable
  const dangerous = [
    "lava",
    "fire",
    "cactus",
    "magma_block",
    "sweet_berry_bush",
    "wither_rose",
  ];
  return !dangerous.some((n) => block.name.includes(n));
}
function isWater(block) {
  return block && block.name.includes("water");
}

// ---------------------------------------------------------------------------
// Neighbor expansion
// ---------------------------------------------------------------------------
const CARDINAL = [
  { x: 1, z: 0, cost: 1 },
  { x: -1, z: 0, cost: 1 },
  { x: 0, z: 1, cost: 1 },
  { x: 0, z: -1, cost: 1 },
];
const DIAGONAL = [
  { x: 1, z: 1, cost: Math.SQRT2 },
  { x: -1, z: -1, cost: Math.SQRT2 },
  { x: 1, z: -1, cost: Math.SQRT2 },
  { x: -1, z: 1, cost: Math.SQRT2 },
];
const ALL_DIRS = [...CARDINAL, ...DIAGONAL];

const MAX_FALL = 3; // blocks we allow free-falling
const MAX_CLIMB = 1; // blocks we can step up without jumping

function getNeighbors(node, bot) {
  const neighbors = [];

  for (const dir of ALL_DIRS) {
    const nx = node.x + dir.x;
    const nz = node.z + dir.z;

    // For diagonals, both cardinal neighbours must be clear (no corner cutting)
    if (dir.x !== 0 && dir.z !== 0) {
      const blockA = bot.blockAt(new Vec3(node.x + dir.x, node.y, node.z));
      const blockB = bot.blockAt(new Vec3(node.x, node.y, node.z + dir.z));
      if (!isPassable(blockA) || !isPassable(blockB)) continue;
    }

    const foot = bot.blockAt(new Vec3(nx, node.y, nz));
    const head = bot.blockAt(new Vec3(nx, node.y + 1, nz));
    const ground = bot.blockAt(new Vec3(nx, node.y - 1, nz));

    // --- Water traversal ---
    if (isWater(foot)) {
      if (isPassable(head)) {
        neighbors.push(
          new Node(nx, node.y, nz, node.g + dir.cost * 1.5, 0, node),
        );
      }
      continue;
    }

    // --- Flat walk ---
    if (isSolid(ground) && isPassable(foot) && isPassable(head)) {
      neighbors.push(new Node(nx, node.y, nz, node.g + dir.cost, 0, node));
      continue;
    }

    // --- Step up (1 block climb) ---
    if (MAX_CLIMB >= 1) {
      const stepFoot = bot.blockAt(new Vec3(nx, node.y + 1, nz));
      const stepHead = bot.blockAt(new Vec3(nx, node.y + 2, nz));
      const stepGround = bot.blockAt(new Vec3(nx, node.y, nz)); // the block we climb onto
      if (isSolid(stepGround) && isPassable(stepFoot) && isPassable(stepHead)) {
        neighbors.push(
          new Node(nx, node.y + 1, nz, node.g + dir.cost + 0.5, 0, node),
        );
        continue;
      }
    }

    // --- Drop down (up to MAX_FALL blocks) ---
    if (isPassable(foot)) {
      for (let drop = 1; drop <= MAX_FALL; drop++) {
        const landY = node.y - drop;
        const landing = bot.blockAt(new Vec3(nx, landY - 1, nz)); // block to stand on
        const landFoot = bot.blockAt(new Vec3(nx, landY, nz));
        const landHead = bot.blockAt(new Vec3(nx, landY + 1, nz));

        if (!isPassable(landFoot) || !isPassable(landHead)) break; // blocked mid-fall

        if (isSolid(landing)) {
          const fallCost = dir.cost + drop * 0.4; // falling is cheap but not free
          neighbors.push(new Node(nx, landY, nz, node.g + fallCost, 0, node));
          break;
        }
      }
    }
  }

  return neighbors;
}

// ---------------------------------------------------------------------------
// Path smoothing — remove intermediate nodes that have clear line of sight
// ---------------------------------------------------------------------------
function hasLOS(bot, a, b) {
  const steps = Math.ceil(a.distanceTo(b) * 2);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor(a.x + (b.x - a.x) * t);
    const y = Math.floor(a.y + (b.y - a.y) * t);
    const z = Math.floor(a.z + (b.z - a.z) * t);
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!isPassable(block)) return false;
    // Also check head
    const head = bot.blockAt(new Vec3(x, y + 1, z));
    if (!isPassable(head)) return false;
  }
  return true;
}

function smoothPath(bot, path) {
  if (path.length <= 2) return path;

  const smoothed = [path[0]];
  let anchor = 0;

  for (let i = 2; i < path.length; i++) {
    const from = new Vec3(path[anchor].x, path[anchor].y, path[anchor].z);
    const to = new Vec3(path[i].x, path[i].y, path[i].z);
    if (!hasLOS(bot, from, to)) {
      smoothed.push(path[i - 1]);
      anchor = i - 1;
    }
  }

  smoothed.push(path[path.length - 1]);
  return smoothed;
}

// ---------------------------------------------------------------------------
// A* core — uses Map for O(1) open-set lookup
// ---------------------------------------------------------------------------
function aStar(bot, startPos, targetPos, opts = {}) {
  const {
    stopDistance = 1.5, // how close to goal counts as "arrived"
    maxNodes = 2000, // bail out after this many expansions
    smooth = true,
  } = opts;

  startPos = startPos.floored().offset(0.5, 0, 0.5);
  targetPos = targetPos.floored().offset(0.5, 0, 0.5);

  const startNode = new Node(
    startPos.x,
    startPos.y,
    startPos.z,
    0,
    heuristic(startPos, targetPos),
  );

  // openMap: key → Node  (best known g for that position)
  const openMap = new Map([[startNode.key, startNode]]);
  // openQueue: sorted array — we keep it sorted by f
  const openQueue = [startNode];
  const closedSet = new Set();
  let expanded = 0;

  while (openQueue.length > 0 && expanded < maxNodes) {
    // Pop node with lowest f
    openQueue.sort((a, b) => a.f - b.f);
    const current = openQueue.shift();
    openMap.delete(current.key);

    if (calculate3DDistance(current, targetPos) <= stopDistance) {
      // Reconstruct path
      const raw = [];
      let n = current;
      while (n) {
        raw.push(new Vec3(n.x, n.y, n.z));
        n = n.parent;
      }
      raw.reverse();
      raw.shift(); // remove start node (bot is already there)

      return smooth ? smoothPath(bot, raw) : raw;
    }

    closedSet.add(current.key);
    expanded++;

    for (const neighbor of getNeighbors(current, bot)) {
      if (closedSet.has(neighbor.key)) continue;

      neighbor.g = current.g + (neighbor.g || 1); // neighbor.g already has move cost from getNeighbors
      neighbor.h = heuristic(neighbor, targetPos);
      neighbor.f = neighbor.g + neighbor.h;
      neighbor.parent = current;

      const existing = openMap.get(neighbor.key);
      if (!existing || neighbor.g < existing.g) {
        openMap.set(neighbor.key, neighbor);
        openQueue.push(neighbor);
      }
    }
  }

  return null; // no path found within budget
}

module.exports = aStar;
module.exports.smoothPath = smoothPath;
module.exports.hasLOS = hasLOS;
module.exports.isPassable = isPassable;
module.exports.isSolid = isSolid;
