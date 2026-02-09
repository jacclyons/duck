const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "duck.html")));
app.use(express.static(path.join(__dirname)));

// Deterministic world seed for consistent object layout
const WORLD_SEED = 12345;
function seededRandom(seed) {
  return function () {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

// Generate same object layout as client (must match duck.html logic)
function generateObjectLayout() {
  const r = seededRandom(WORLD_SEED);
  const objects = [];
  for (let i = 0; i < 160; i++) {
    const x = -165 + r() * 330;
    const z = -165 + r() * 330;
    const y = 0.7 + r() * 0.4;
    const pick = r();
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

const objects = generateObjectLayout();
const players = new Map(); // id -> { x, y, z, yaw, pitch, velY, heldId, color }

const DUCK_COLORS = [0xf5d547, 0x7dd3fc, 0xa3e635, 0xfb7185, 0xc084fc];

function getNextColor() {
  const used = new Set([...players.values()].map((p) => p.color));
  for (const c of DUCK_COLORS) {
    if (!used.has(c)) return c;
  }
  return DUCK_COLORS[players.size % DUCK_COLORS.length];
}

io.on("connection", (socket) => {
  const id = socket.id;
  const color = getNextColor();
  players.set(id, {
    x: 0, y: 2, z: 18,
    yaw: 0, pitch: 0, velY: 0,
    heldId: null,
    grabbedBy: null,
    color,
  });

  socket.emit("init", {
    yourId: id,
    players: Object.fromEntries(
      [...players.entries()].map(([k, v]) => [k, { ...v, id: k }])
    ),
    objects: objects.map((o) => ({
      id: o.id,
      x: o.x, y: o.y, z: o.z,
      vx: o.vx, vy: o.vy, vz: o.vz,
      mass: o.mass,
      size: o.size,
      heldBy: o.heldBy,
    })),
  });

  socket.broadcast.emit("playerJoined", {
    id,
    x: 0, y: 2, z: 18,
    yaw: 0, pitch: 0, velY: 0,
    heldId: null,
    color,
  });

  socket.on("playerUpdate", (data) => {
    const p = players.get(id);
    if (!p) return;
    p.x = data.x;
    p.y = data.y;
    p.z = data.z;
    p.yaw = data.yaw;
    p.pitch = data.pitch;
    p.velY = data.velY ?? p.velY;
    socket.broadcast.emit("playerUpdate", { id, ...data });
    // If this player is holding another, send grabbed position to the held player
    if (data.heldPlayerId) {
      const held = players.get(data.heldPlayerId);
      if (held && held.grabbedBy === id) {
        const forward = { x: -Math.sin(p.yaw), y: 0, z: -Math.cos(p.yaw) };
        const dist = data.holdDistance ?? 6;
        const height = data.holdHeight ?? 5;
        const x = p.x + forward.x * dist;
        const z = p.z + forward.z * dist;
        io.to(data.heldPlayerId).emit("grabbedPosition", { x, y: height, z });
      }
    }
  });

  socket.on("grab", (objectId) => {
    const obj = objects[objectId];
    const p = players.get(id);
    if (!obj || !p || obj.heldBy !== null) return;
    obj.heldBy = id;
    p.heldId = objectId;
    io.emit("grab", { playerId: id, objectId });
  });

  socket.on("throw", (data) => {
    const { objectId, vx, vy, vz } = data;
    const obj = objects[objectId];
    const p = players.get(id);
    if (!obj || !p || obj.heldBy !== id) return;
    obj.heldBy = null;
    p.heldId = null;
    obj.vx = vx;
    obj.vy = vy;
    obj.vz = vz;
    io.emit("throw", { playerId: id, objectId, vx, vy, vz });
  });

  socket.on("drop", (objectId) => {
    const obj = objects[objectId];
    const p = players.get(id);
    if (!obj || !p || obj.heldBy !== id) return;
    obj.heldBy = null;
    p.heldId = null;
    io.emit("drop", { playerId: id, objectId });
  });

  socket.on("grabPlayer", (grabbedId) => {
    const grabber = players.get(id);
    const grabbed = players.get(grabbedId);
    if (!grabber || !grabbed || grabbed.grabbedBy) return;
    grabbed.grabbedBy = id;
    io.emit("playerGrabbed", { grabberId: id, grabbedId });
  });

  socket.on("releasePlayer", () => {
    const grabber = players.get(id);
    if (!grabber) return;
    const grabbedId = [...players.entries()].find(([_, p]) => p.grabbedBy === id)?.[0];
    if (!grabbedId) return;
    players.get(grabbedId).grabbedBy = null;
    io.emit("playerReleased", { grabberId: id, grabbedId });
  });

  socket.on("throwPlayer", (data) => {
    const { grabbedId, vx, vy, vz } = data;
    const grabber = players.get(id);
    const grabbed = players.get(grabbedId);
    if (!grabber || !grabbed || grabbed.grabbedBy !== id) return;
    grabbed.grabbedBy = null;
    io.to(grabbedId).emit("playerThrown", { vx, vy, vz });
    io.emit("playerReleased", { grabberId: id, grabbedId });
  });

  socket.on("hitPlayer", (data) => {
    const { targetId, vx, vy, vz } = data;
    if (!players.has(targetId)) return;
    io.to(targetId).emit("hitBy", { vx, vy, vz });
  });

  socket.on("objectSync", (data) => {
    const obj = objects[data.id];
    if (!obj || obj.heldBy !== null) return;
    obj.x = data.x;
    obj.y = data.y;
    obj.z = data.z;
    obj.vx = data.vx;
    obj.vy = data.vy;
    obj.vz = data.vz;
    socket.broadcast.emit("objectSync", data);
  });

  socket.on("disconnect", () => {
    const p = players.get(id);
    if (p?.heldId !== null) {
      const obj = objects[p.heldId];
      if (obj) {
        obj.heldBy = null;
        io.emit("drop", { playerId: id, objectId: p.heldId });
      }
    }
    const grabbedId = p ? [...players.entries()].find(([_, pl]) => pl.grabbedBy === id)?.[0] : null;
    if (grabbedId) {
      players.get(grabbedId).grabbedBy = null;
      io.emit("playerReleased", { grabberId: id, grabbedId });
    }
    players.delete(id);
    io.emit("playerLeft", id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`DUCK! server on http://localhost:${PORT}`);
});
