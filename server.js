const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS = [
  "https://duck-trueos.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const normalized = origin ? origin.replace(/\/$/, "") : "";
      const allowed = ALLOWED_ORIGINS.some((o) => o.replace(/\/$/, "") === normalized);
      if (!origin || allowed) return callback(null, origin || true);
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "duck.html")));
app.use(express.static(path.join(__dirname)));

// --- Constants (match duck.html) ---
const WORLD_SEED = 12345;
const GRAVITY = 28;
const DAMPING = 0.985;
const FLOOR_Y = 0;
const BREAK_SPEED = 55;
const NPC_COUNT = 20;
const BLOCKS = 7;
const SPACING = 28;
const ROAD = 10;
const DUCK_HALF_Y = 1.2;
const DUCK_SIZE = { x: 1.2, y: 2.4, z: 1.2 };

const DUCK_COLORS = [0xf5d547, 0x7dd3fc, 0xa3e635, 0xfb7185, 0xc084fc];

function seededRandom(seed) {
  return function () {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function generateObjectLayout() {
  const r = seededRandom(WORLD_SEED);
  const objects = [];
  for (let i = 0; i < 160; i++) {
    // Determine type deterministically to match client
    const pick = r();
    // Randomize position to avoid initial collisions (like offline mode)
    const x = -90 + Math.random() * 180;
    const z = -90 + Math.random() * 180;
    const y = 1.2 + Math.random() * 1.2;
    
    let sx, sy, sz, mass;
    if (pick < 0.55) {
      sx = 0.6 + r() * 0.8; sy = 0.6 + r() * 1.0; sz = 0.6 + r() * 0.8;
      mass = 0.8 + r() * 1.7;
    } else if (pick < 0.85) {
      const rad = 0.25 + r() * 0.3;
      const h = 0.8 + r() * 1.0;
      sx = rad * 2; sy = h; sz = rad * 2;
      mass = 0.6 + r() * 1.0;
    } else {
      sx = 1.5 + r() * 1.3; sy = 0.7 + r() * 0.5; sz = 2.4 + r() * 2.4;
      mass = 2.5 + r() * 3.5;
    }
    objects.push({
      id: i,
      x, y, z,
      vx: 0, vy: 0, vz: 0,
      mass,
      size: { x: sx, y: sy, z: sz },
      heldBy: null,
    });
  }
  return objects;
}

function generateBuildingColliders() {
  const worldRand = seededRandom(WORLD_SEED);
  const worldRandRange = (min, max) => min + worldRand() * (max - min);
  const colliders = [];
  let nextId = 0;
  for (let bx = -BLOCKS; bx <= BLOCKS; bx++) {
    for (let bz = -BLOCKS; bz <= BLOCKS; bz++) {
      const px = bx * SPACING;
      const pz = bz * SPACING;
      if (Math.abs(px) < ROAD || Math.abs(pz) < ROAD) continue;
      const count = 3 + ((worldRand() * 4) | 0);
      for (let i = 0; i < count; i++) {
        const w = worldRandRange(6, 14);
        const d = worldRandRange(6, 14);
        const h = worldRandRange(10, 42);
        const ox = worldRandRange(-8, 8);
        const oz = worldRandRange(-8, 8);
        const cx = px + ox;
        const cz = pz + oz;
        colliders.push({
          id: nextId++,
          min: { x: cx - w / 2, y: 0, z: cz - d / 2 },
          max: { x: cx + w / 2, y: h, z: cz + d / 2 },
        });
      }
    }
  }
  for (let i = 0; i < 22; i++) {
    const x = worldRandRange(-140, 140);
    const z = worldRandRange(-140, 140);
    if (Math.abs(x) < 18 || Math.abs(z) < 18) continue;
    const w = worldRandRange(10, 22);
    const d = worldRandRange(10, 22);
    const h = worldRandRange(45, 95);
    colliders.push({
      id: nextId++,
      min: { x: x - w / 2, y: 0, z: z - d / 2 },
      max: { x: x + w / 2, y: h, z: z + d / 2 },
    });
  }
  return colliders;
}

function createNPCs(worldRand, worldRandRange) {
  const npcs = [];
  const npcColors = [0xf5d547, 0x7dd3fc, 0xa3e635, 0xfb7185, 0xc084fc, 0xfbbf24, 0x67e8f9, 0xf472b6];
  for (let i = 0; i < NPC_COUNT; i++) {
    const tx = worldRandRange(-80, 80);
    const tz = worldRandRange(-80, 80);
    const dx = worldRandRange(-1, 1);
    const dz = worldRandRange(-1, 1);
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    npcs.push({
      x: tx, y: DUCK_HALF_Y, z: tz,
      vx: 0, vy: 0, vz: 0,
      targetDir: { x: dx / len, y: 0, z: dz / len },
      changeDirTimer: worldRandRange(1, 4),
      speed: worldRandRange(2.5, 5),
      paused: false,
      pauseTimer: 0,
      grabbed: false,
      hitboxSize: { ...DUCK_SIZE },
    });
  }
  return npcs;
}

function aabbIntersects(a, b) {
  return a.min.x <= b.max.x && a.max.x >= b.min.x &&
         a.min.y <= b.max.y && a.max.y >= b.min.y &&
         a.min.z <= b.max.z && a.max.z >= b.min.z;
}

function meshAABB(obj) {
  const hx = obj.size.x * 0.5, hy = obj.size.y * 0.5, hz = obj.size.z * 0.5;
  return {
    min: { x: obj.x - hx, y: obj.y - hy, z: obj.z - hz },
    max: { x: obj.x + hx, y: obj.y + hy, z: obj.z + hz },
  };
}

function npcAABB(npc, pos) {
  const hx = DUCK_SIZE.x * 0.5, hy = DUCK_SIZE.y * 0.5, hz = DUCK_SIZE.z * 0.5;
  const p = pos || npc;
  return {
    min: { x: p.x - hx, y: p.y - hy, z: p.z - hz },
    max: { x: p.x + hx, y: p.y + hy, z: p.z + hz },
  };
}

function vecLen(v) {
  const x = v.vx ?? v.x ?? 0;
  const y = v.vy ?? v.y ?? 0;
  const z = v.vz ?? v.z ?? 0;
  return Math.sqrt(x * x + y * y + z * z);
}

function vecLenSq(v) {
  const x = v.vx ?? v.x ?? 0;
  const y = v.vy ?? v.y ?? 0;
  const z = v.vz ?? v.z ?? 0;
  return x * x + y * y + z * z;
}

function resolveDynamicCollisions(obj, colliders) {
  const halfY = obj.size.y * 0.5;
  if (obj.y - halfY < FLOOR_Y) {
    obj.y = FLOOR_Y + halfY;
    if (obj.vy < 0) obj.vy *= 0.35;
    obj.vx *= 0.8;
    obj.vz *= 0.8;
  }
  const box = meshAABB(obj);
  for (const c of colliders) {
    if (!aabbIntersects(box, c)) continue;
    const overlapX = Math.min(box.max.x - c.min.x, c.max.x - box.min.x);
    const overlapY = Math.min(box.max.y - c.min.y, c.max.y - box.min.y);
    const overlapZ = Math.min(box.max.z - c.min.z, c.max.z - box.min.z);
    if (overlapY <= overlapX && overlapY <= overlapZ) {
      obj.y += (obj.y > (c.min.y + c.max.y) * 0.5) ? overlapY + 0.01 : -(overlapY + 0.01);
      obj.vy *= -0.25;
    } else if (overlapX <= overlapZ) {
      obj.x += (obj.x > (c.min.x + c.max.x) * 0.5) ? overlapX + 0.01 : -(overlapX + 0.01);
      obj.vx *= -0.3;
    } else {
      obj.z += (obj.z > (c.min.z + c.max.z) * 0.5) ? overlapZ + 0.01 : -(overlapZ + 0.01);
      obj.vz *= -0.3;
    }
    const b2 = meshAABB(obj);
    box.min = b2.min;
    box.max = b2.max;
  }
}

function checkBuildingDestruction(obj, colliders, onDestroy) {
  const speed = Math.sqrt(obj.vx * obj.vx + obj.vy * obj.vy + obj.vz * obj.vz);
  if (speed < BREAK_SPEED) return;
  const mBox = meshAABB(obj);
  for (let i = colliders.length - 1; i >= 0; i--) {
    const c = colliders[i];
    if (!aabbIntersects(mBox, c)) continue;
    onDestroy(c.id);
    colliders.splice(i, 1);
    obj.vx *= 0.4;
    obj.vy *= 0.4;
    obj.vz *= 0.4;
    return;
  }
}

function randomRoomId() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

const rooms = new Map();

function getNextColor(players) {
  const used = new Set([...players.values()].map((p) => p.color));
  for (const c of DUCK_COLORS) {
    if (!used.has(c)) return c;
  }
  return DUCK_COLORS[players.size % DUCK_COLORS.length];
}

function createRoom(socketId, ducktag) {
  const roomId = randomRoomId();
  if (rooms.has(roomId)) return createRoom(socketId, ducktag);
  const color = getNextColor(new Map());
  const worldRand = seededRandom(WORLD_SEED);
  const worldRandRange = (min, max) => min + worldRand() * (max - min);
  const room = {
    objects: generateObjectLayout(),
    players: new Map([[socketId, {
      x: 0, y: 2, z: 18,
      yaw: 0, pitch: 0, velY: 0,
      heldId: null, grabbedBy: null,
      color, ducktag: ducktag || "Ducky1234",
    }]]),
    colliders: generateBuildingColliders(),
    npcs: createNPCs(worldRand, worldRandRange),
  };
  rooms.set(roomId, room);
  return roomId;
}

function joinRoom(roomId, socketId, ducktag) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const color = getNextColor(room.players);
  room.players.set(socketId, {
    x: 0, y: 2, z: 18,
    yaw: 0, pitch: 0, velY: 0,
    heldId: null, grabbedBy: null,
    color, ducktag: ducktag || "Ducky1234",
  });
  return room;
}

function tickRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const dt = 1 / 60; // 60Hz server tick
  const { objects, players, colliders, npcs } = room;

  // Object physics
  for (const obj of objects) {
    if (obj.heldBy !== null) continue;
    obj.vy -= GRAVITY * dt;
    obj.vx *= DAMPING;
    obj.vy *= DAMPING;
    obj.vz *= DAMPING;
    obj.x += obj.vx * dt;
    obj.y += obj.vy * dt;
    obj.z += obj.vz * dt;
    checkBuildingDestruction(obj, colliders, (buildingId) => {
      io.to(roomId).emit("buildingDestroyed", { buildingId });
    });
    resolveDynamicCollisions(obj, colliders);
  }

  // Object-to-NPC
  for (const obj of objects) {
    const speed = Math.sqrt(obj.vx * obj.vx + obj.vy * obj.vy + obj.vz * obj.vz);
    if (speed < 2) continue;
    const mBox = meshAABB(obj);
    for (const npc of npcs) {
      if (npc.grabbed) continue;
      const nBox = npcAABB(npc);
      if (!aabbIntersects(mBox, nBox)) continue;
      const mass = obj.mass || 1.5;
      const knockX = obj.vx * 0.8 / Math.max(0.5, mass);
      const knockY = Math.max(obj.vy * 0.8 / Math.max(0.5, mass), 4 + speed * 0.2);
      const knockZ = obj.vz * 0.8 / Math.max(0.5, mass);
      npc.vx += knockX;
      npc.vy += knockY;
      npc.vz += knockZ;
      obj.vx *= 0.3;
      obj.vy *= 0.3;
      obj.vz *= 0.3;
      break;
    }
  }

  // NPC-to-NPC
  for (const a of npcs) {
    const aSpeed = vecLen(a);
    if (aSpeed < 5) continue;
    const aBox = npcAABB(a);
    for (const b of npcs) {
      if (a === b || b.grabbed) continue;
      const bBox = npcAABB(b);
      if (!aabbIntersects(aBox, bBox)) continue;
      const knock = 0.6 * aSpeed;
      b.vx += a.vx * 0.6 / aSpeed * knock;
      b.vy += Math.max(a.vy * 0.6 / aSpeed * knock, 3 + aSpeed * 0.15);
      b.vz += a.vz * 0.6 / aSpeed * knock;
      a.vx *= 0.4;
      a.vy *= 0.4;
      a.vz *= 0.4;
      break;
    }
  }

  // NPC physics
  for (const npc of npcs) {
    if (npc.grabbed) continue;
    const velLenSq = vecLenSq(npc);
    if (npc.y > 1.2 || velLenSq > 4) {
      npc.vy -= GRAVITY * dt;
      npc.vx *= 0.995;
      npc.vy *= 0.995;
      npc.vz *= 0.995;
      npc.x += npc.vx * dt;
      npc.y += npc.vy * dt;
      npc.z += npc.vz * dt;

      const npcSpeed = vecLen(npc);
      if (npcSpeed >= BREAK_SPEED) {
        const nBox = npcAABB(npc);
        for (let i = colliders.length - 1; i >= 0; i--) {
          const c = colliders[i];
          if (!aabbIntersects(nBox, c)) continue;
          io.to(roomId).emit("buildingDestroyed", { buildingId: c.id });
          colliders.splice(i, 1);
          npc.vx *= 0.4;
          npc.vy *= 0.4;
          npc.vz *= 0.4;
          break;
        }
      }

      const nBox = npcAABB(npc);
      for (const c of colliders) {
        if (!aabbIntersects(nBox, c)) continue;
        const overlapX = Math.min(nBox.max.x - c.min.x, c.max.x - nBox.min.x);
        const overlapZ = Math.min(nBox.max.z - c.min.z, c.max.z - nBox.min.z);
        if (overlapX < overlapZ) {
          npc.x += (npc.x > (c.min.x + c.max.x) * 0.5) ? overlapX + 0.01 : -(overlapX + 0.01);
          npc.vx *= -0.4;
        } else {
          npc.z += (npc.z > (c.min.z + c.max.z) * 0.5) ? overlapZ + 0.01 : -(overlapZ + 0.01);
          npc.vz *= -0.4;
        }
        break;
      }

      const npcFloorY = DUCK_SIZE.y * 0.5;
      if (npc.y < npcFloorY) {
        npc.y = npcFloorY;
        if (npc.vy < 0) npc.vy *= -0.3;
        npc.vx *= 0.7;
        npc.vz *= 0.7;
      }

      if (npc.y <= npcFloorY + 0.05 && vecLen(npc) < 1.5) {
        npc.vx = npc.vy = npc.vz = 0;
        npc.changeDirTimer = rand(0.5, 2);
      }
      continue;
    }

    npc.changeDirTimer -= dt;
    if (npc.changeDirTimer <= 0) {
      if (!npc.paused && Math.random() < 0.3) {
        npc.paused = true;
        npc.pauseTimer = rand(1, 3);
      } else {
        npc.paused = false;
        const dx = rand(-1, 1), dz = rand(-1, 1);
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        npc.targetDir = { x: dx / len, y: 0, z: dz / len };
        npc.speed = rand(2.5, 5);
      }
      npc.changeDirTimer = rand(1.5, 5);
    }

    if (npc.paused) {
      npc.pauseTimer -= dt;
      if (npc.pauseTimer <= 0) npc.paused = false;
      continue;
    }

    const moveX = npc.targetDir.x * npc.speed * dt;
    const moveZ = npc.targetDir.z * npc.speed * dt;
    const nextPos = { x: npc.x + moveX, y: DUCK_SIZE.y * 0.5, z: npc.z + moveZ };
    const box = npcAABB(nextPos);
    let blocked = false;
    for (const c of colliders) {
      if (aabbIntersects(box, c)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      npc.x = nextPos.x;
      npc.z = nextPos.z;
    } else {
      const dx = rand(-1, 1), dz = rand(-1, 1);
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      npc.targetDir = { x: dx / len, y: 0, z: dz / len };
      npc.changeDirTimer = rand(0.5, 2);
    }

    if (Math.abs(npc.x) > 150 || Math.abs(npc.z) > 150) {
      const l = Math.sqrt(npc.x * npc.x + npc.z * npc.z) || 1;
      npc.targetDir = { x: -npc.x / l, y: 0, z: -npc.z / l };
    }
  }
}

// 60Hz server physics tick
setInterval(() => {
  for (const [roomId] of rooms) {
    tickRoom(roomId);
  }
}, 1000 / 60);

// 20Hz authoritative state broadcast (position + velocity for client-side prediction)
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.players.size === 0) continue;
    const payload = {
      objects: room.objects.map((o) => ({
        id: o.id, x: o.x, y: o.y, z: o.z,
        vx: o.vx, vy: o.vy, vz: o.vz,
        heldBy: o.heldBy,
      })),
      npcs: room.npcs.map((n) => ({
        x: n.x, y: n.y, z: n.z,
        vx: n.vx, vy: n.vy, vz: n.vz,
      })),
    };
    io.to(roomId).emit("envUpdate", payload);
  }
}, 50); // 50ms = 20Hz

io.on("connection", (socket) => {
  socket.on("listRooms", (callback) => {
    if (typeof callback !== "function") return;
    try {
      const list = [];
      for (const [roomId, room] of rooms) {
        const playerCount = room.players ? room.players.size : 0;
        if (playerCount > 0) {
          list.push({ roomId, playerCount });
        }
      }
      callback(list);
    } catch (err) {
      console.error("listRooms error", err);
      callback([]);
    }
  });

  socket.on("createRoom", (data) => {
    const ducktag = (data && data.ducktag) || "Ducky1234";
    const roomId = createRoom(socket.id, ducktag);
    socket.roomId = roomId;
    socket.join(roomId);
    const room = rooms.get(roomId);
    const players = room.players;
    socket.emit("roomCreated", { roomId });
    socket.emit("init", {
      yourId: socket.id,
      players: Object.fromEntries(
        [...players.entries()].map(([k, v]) => [k, { ...v, id: k }])
      ),
      objects: room.objects.map((o) => ({
        id: o.id, x: o.x, y: o.y, z: o.z,
        vx: o.vx, vy: o.vy, vz: o.vz,
        mass: o.mass, size: o.size, heldBy: o.heldBy,
      })),
    });
  });

  socket.on("joinRoom", (data) => {
    const roomId = (data && data.roomId) || data;
    const ducktag = (data && data.ducktag) || "Ducky1234";
    const room = joinRoom(roomId, socket.id, ducktag);
    if (!room) {
      socket.emit("roomNotFound");
      return;
    }
    socket.roomId = roomId;
    socket.join(roomId);
    socket.emit("init", {
      yourId: socket.id,
      players: Object.fromEntries(
        [...room.players.entries()].map(([k, v]) => [k, { ...v, id: k }])
      ),
      objects: room.objects.map((o) => ({
        id: o.id, x: o.x, y: o.y, z: o.z,
        vx: o.vx, vy: o.vy, vz: o.vz,
        mass: o.mass, size: o.size, heldBy: o.heldBy,
      })),
    });
    socket.to(roomId).emit("playerJoined", {
      id: socket.id,
      x: 0, y: 2, z: 18,
      yaw: 0, pitch: 0, velY: 0,
      heldId: null,
      color: room.players.get(socket.id).color,
      ducktag,
    });
  });

  socket.on("leaveRoom", () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
      const p = room.players.get(socket.id);
      if (p?.heldId != null) {
        const obj = room.objects[p.heldId];
        if (obj) {
          obj.heldBy = null;
          io.to(roomId).emit("drop", { playerId: socket.id, objectId: p.heldId });
        }
      }
      const grabbedId = [...room.players.entries()].find(([_, pl]) => pl.grabbedBy === socket.id)?.[0];
      if (grabbedId) {
        room.players.get(grabbedId).grabbedBy = null;
        io.to(roomId).emit("playerReleased", { grabberId: socket.id, grabbedId });
      }
      // Release any NPCs this player was holding
      for (const npc of room.npcs) {
        if (npc.grabbedBy === socket.id) { npc.grabbed = false; npc.grabbedBy = null; }
      }
      room.players.delete(socket.id);
      io.to(roomId).emit("playerLeft", socket.id);
      if (room.players.size === 0) rooms.delete(roomId);
    }
    socket.leave(roomId);
    socket.roomId = null;
  });

  socket.on("playerUpdate", (data) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const p = room?.players.get(socket.id);
    if (!p) return;
    p.x = data.x;
    p.y = data.y;
    p.z = data.z;
    p.yaw = data.yaw;
    p.pitch = data.pitch;
    p.velY = data.velY ?? p.velY;
    p.holdDistance = data.holdDistance;
    p.holdHeight = data.holdHeight;
    socket.to(roomId).emit("playerUpdate", { id: socket.id, ...data });
    if (data.heldPlayerId) {
      const held = room.players.get(data.heldPlayerId);
      if (held && held.grabbedBy === socket.id) {
        const dist = data.holdDistance ?? 6;
        const height = data.holdHeight ?? 5;
        const x = p.x + -Math.sin(p.yaw) * dist;
        const z = p.z + -Math.cos(p.yaw) * dist;
        io.to(data.heldPlayerId).emit("grabbedPosition", { x, y: height, z });
      }
    }
  });

  socket.on("myDucktag", (data) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const p = room?.players.get(socket.id);
    if (!p) return;
    p.ducktag = data.ducktag || "Ducky1234";
    io.to(roomId).emit("playerDucktag", { id: socket.id, ducktag: p.ducktag });
  });

  socket.on("grab", (objectId) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const obj = room?.objects[objectId];
    const p = room?.players.get(socket.id);
    if (!obj || !p || obj.heldBy !== null) return;
    obj.heldBy = socket.id;
    p.heldId = objectId;
    io.to(roomId).emit("grab", { playerId: socket.id, objectId });
  });

  // Held-object position: holder sends their telekinesis position so others see smooth movement
  socket.on("heldObjectPos", (data) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const obj = room?.objects[data.objectId];
    if (!obj || obj.heldBy !== socket.id) return;
    // Update server state so envUpdate doesn't fight the holder's position
    obj.x = data.x;
    obj.y = data.y;
    obj.z = data.z;
    obj.vx = 0;
    obj.vy = 0;
    obj.vz = 0;
    // Broadcast to other clients
    socket.to(roomId).emit("heldObjectPos", {
      objectId: data.objectId,
      x: data.x, y: data.y, z: data.z,
    });
  });

  socket.on("throw", (data) => {
    const { objectId, vx, vy, vz, x, y, z } = data;
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const obj = room?.objects[objectId];
    const p = room?.players.get(socket.id);
    if (!obj || !p || obj.heldBy !== socket.id) return;
    obj.heldBy = null;
    p.heldId = null;
    if (x != null && y != null && z != null) {
      obj.x = x;
      obj.y = y;
      obj.z = z;
    }
    obj.vx = vx;
    obj.vy = vy;
    obj.vz = vz;
    io.to(roomId).emit("throw", { playerId: socket.id, objectId, vx, vy, vz });
  });

  socket.on("drop", (objectId) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const obj = room?.objects[objectId];
    const p = room?.players.get(socket.id);
    if (!obj || !p || obj.heldBy !== socket.id) return;
    obj.heldBy = null;
    p.heldId = null;
    io.to(roomId).emit("drop", { playerId: socket.id, objectId });
  });

  socket.on("grabPlayer", (grabbedId) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const grabber = room?.players.get(socket.id);
    const grabbed = room?.players.get(grabbedId);
    if (!grabber || !grabbed || grabbed.grabbedBy) return;
    grabbed.grabbedBy = socket.id;
    io.to(roomId).emit("playerGrabbed", { grabberId: socket.id, grabbedId });
  });

  socket.on("releasePlayer", () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const grabber = room?.players.get(socket.id);
    if (!grabber) return;
    const grabbedId = [...room.players.entries()].find(([_, p]) => p.grabbedBy === socket.id)?.[0];
    if (!grabbedId) return;
    room.players.get(grabbedId).grabbedBy = null;
    io.to(roomId).emit("playerReleased", { grabberId: socket.id, grabbedId });
  });

  socket.on("throwPlayer", (data) => {
    const { grabbedId, vx, vy, vz } = data;
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const grabber = room?.players.get(socket.id);
    const grabbed = room?.players.get(grabbedId);
    if (!grabber || !grabbed || grabbed.grabbedBy !== socket.id) return;
    grabbed.grabbedBy = null;
    io.to(grabbedId).emit("playerThrown", { vx, vy, vz });
    io.to(roomId).emit("playerReleased", { grabberId: socket.id, grabbedId });
  });

  socket.on("hitPlayer", (data) => {
    const { targetId, vx, vy, vz } = data;
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room?.players.has(targetId)) return;
    io.to(targetId).emit("hitBy", { vx, vy, vz });
  });

  // ── NPC grab / throw / drop ──────────────────────────────────────
  socket.on("grabNpc", (npcIdx) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const npc = room?.npcs[npcIdx];
    if (!npc || npc.grabbed) return;
    npc.grabbed = true;
    npc.grabbedBy = socket.id;
    socket.to(roomId).emit("npcGrabbed", { npcIdx, playerId: socket.id });
  });

  socket.on("throwNpc", (data) => {
    const { npcIdx, x, y, z, vx, vy, vz } = data;
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const npc = room?.npcs[npcIdx];
    if (!npc || npc.grabbedBy !== socket.id) return;
    npc.grabbed = false;
    npc.grabbedBy = null;
    npc.x = x; npc.y = y; npc.z = z;
    npc.vx = vx; npc.vy = vy; npc.vz = vz;
    socket.to(roomId).emit("npcThrown", { npcIdx, x, y, z, vx, vy, vz });
  });

  socket.on("dropNpc", (npcIdx) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const npc = room?.npcs[npcIdx];
    if (!npc || npc.grabbedBy !== socket.id) return;
    npc.grabbed = false;
    npc.grabbedBy = null;
    socket.to(roomId).emit("npcDropped", { npcIdx });
  });

  socket.on("heldNpcPos", (data) => {
    const { npcIdx, x, y, z } = data;
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const npc = room?.npcs[npcIdx];
    if (!npc || npc.grabbedBy !== socket.id) return;
    // Update server state so envUpdate doesn't fight
    npc.x = x; npc.y = y; npc.z = z;
    npc.vx = 0; npc.vy = 0; npc.vz = 0;
    socket.to(roomId).emit("heldNpcPos", { npcIdx, x, y, z });
  });

  socket.on("objectHitPlayer", (data) => {
    const { objectIndex } = data;
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const obj = room?.objects[objectIndex];
    if (!obj) return;
    obj.vx *= 0.25;
    obj.vy *= 0.25;
    obj.vz *= 0.25;
  });

  socket.on("npcHitPlayer", (data) => {
    const { npcIndex } = data;
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    const npc = room?.npcs[npcIndex];
    if (!npc) return;
    npc.vx *= 0.35;
    npc.vy *= 0.35;
    npc.vz *= 0.35;
  });

  socket.on("resetWorld", () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.objects = generateObjectLayout();
    const payload = {
      objects: room.objects.map((o) => ({
        id: o.id, x: o.x, y: o.y, z: o.z,
        vx: o.vx, vy: o.vy, vz: o.vz,
        heldBy: o.heldBy,
      })),
    };
    io.to(roomId).emit("worldReset", payload);
  });

  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
      const p = room.players.get(socket.id);
      if (p?.heldId != null) {
        const obj = room.objects[p.heldId];
        if (obj) {
          obj.heldBy = null;
          io.to(roomId).emit("drop", { playerId: socket.id, objectId: p.heldId });
        }
      }
      const grabbedId = [...room.players.entries()].find(([_, pl]) => pl.grabbedBy === socket.id)?.[0];
      if (grabbedId) {
        room.players.get(grabbedId).grabbedBy = null;
        io.to(roomId).emit("playerReleased", { grabberId: socket.id, grabbedId });
      }
      // Release any NPCs this player was holding
      for (const npc of room.npcs) {
        if (npc.grabbedBy === socket.id) { npc.grabbed = false; npc.grabbedBy = null; }
      }
      room.players.delete(socket.id);
      io.to(roomId).emit("playerLeft", socket.id);
      if (room.players.size === 0) rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`DUCK! server on http://localhost:${PORT}`);
});
