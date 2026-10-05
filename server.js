"use strict";
/* Servidor en línea de Dino Blades.
   Ejecuta el MISMO código del juego (index.html) sin pantalla: bots, zona, meteoritos y jefe funcionan igual,
   y los jugadores reales se conectan por WebSocket. El servidor es el que manda: los jugadores solo envían hacia dónde quieren moverse. */
const http = require("http"), fs = require("fs"), path = require("path"), vm = require("vm");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const BOTS = +process.env.BOTS || 35;              // rivales controlados por el servidor
const KNIVES = +process.env.KNIVES || 0.5;         // espadas en el suelo (1 = igual que en solitario)
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 30;
const TICK_MS = 50;                                // 20 actualizaciones por segundo
const ROUND_END = 210;                             // segundos: la zona queda toda roja a los 200 s; a los 210 empieza otra partida
const LOCK_AT = ROUND_END - 15;                    // en los últimos 15 s ya no se puede reaparecer

const HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const CODE = HTML.split("<script>")[1].split("</script>")[0];

/* Código extra que se ejecuta dentro del juego: convierte los avisos visuales/sonoros en eventos para enviar a los jugadores */
const GLUE = `
;(() => {
  const EV = [], r = Math.round;
  feed = (m, c) => EV.push(["f", m, c]);            banner = (t, c) => EV.push(["b", t, c]);
  sparks = (x, y, n) => EV.push(["sp", r(x), r(y), n]);  flash = (x, y, s) => EV.push(["fl", r(x), r(y), r(s)]);
  boom = (x, y, c) => EV.push(["bm", r(x), r(y), c]);
  sfxClash = (x, y) => EV.push(["c", r(x), r(y)]);  sfxKill = (x, y) => EV.push(["k", r(x), r(y)]);
  sfxMeteor = (x, y) => EV.push(["m", r(x), r(y)]); sfxAlarm = () => EV.push(["al"]); sfxBoss = () => EV.push(["bo"]);
  sfxBurn = sfxPick = sfxPower = sfxEvolve = sfxOver = () => {};
  player.alive = false; started = true;
  globalThis.API = { EV, enemies, knives, powerups, obstacles, meteors, zone, update, validateNick, SKINS, makeEntity, zoneRandomPoint, blockedAt,
    get clock() { return gameClock; } };
})();`;

function newSim() {
  const noop = () => {};
  const ctx = new Proxy({}, { get: (t, p) => p === "measureText" ? () => ({ width: 50 }) : (p === "createLinearGradient" || p === "createRadialGradient") ? () => ({ addColorStop: noop }) : noop, set: () => true });
  const els = {};
  const mk = () => ({ style: {}, children: [], textContent: "", innerHTML: "", value: "", addEventListener: noop, focus: noop, blur: noop, getContext: () => ctx,
    appendChild(c) { this.children.push(c); }, removeChild(c) { this.children = this.children.filter(x => x !== c); }, get firstChild() { return this.children[0]; } });
  const sb = {
    SERVER_MODE: true, SERVER_BOTS: BOTS, SERVER_KN: KNIVES, console, setTimeout, clearTimeout, setInterval: noop, requestAnimationFrame: noop,
    performance: { now: () => Date.now() }, location: { reload: noop, protocol: "http:", host: "localhost" },
    localStorage: { getItem: () => null, setItem: noop }, Image: class {}, screen: {},
    window: { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: noop },
    document: { getElementById: id => els[id] || (els[id] = mk()), createElement: mk, addEventListener: noop, documentElement: {}, hidden: false }
  };
  const context = vm.createContext(sb);
  vm.runInContext(CODE + GLUE, context, { filename: "game.js" });
  return context.API;
}

/* ---------- Servidor web (sirve el juego) ---------- */
const FILES = { "/": "index.html", "/index.html": "index.html", "/manifest.json": "manifest.json", "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png" };
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png" };
const web = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/health") { res.end("ok"); return; }
  const f = FILES[url], full = f && path.join(__dirname, f);
  if (!f || !fs.existsSync(full)) { res.writeHead(404); res.end("No encontrado"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] });
  fs.createReadStream(full).pipe(res);
});

/* ---------- Partida ---------- */
let sim = newSim(), roundEnd = ROUND_END, tickN = 0, nextEid = 5000, nextHid = 10000;
const humans = new Map();
const send = (h, o) => { if (h.ws.readyState === 1) h.ws.send(JSON.stringify(o)); };
const broadcast = (o, except) => { const s = JSON.stringify(o); for (const h of humans.values()) if (h !== except && h.ws.readyState === 1) h.ws.send(s); };
const score = e => e.kills * 100 + e.peak * 2 + Math.max(0, Math.floor(sim.clock - e.born));
const flags = o => (o.defensive ? 1 : 0) | (o.faceRight ? 2 : 0) | (o.shieldTimer > 0 ? 4 : 0) | (o.speedTimer > 0 ? 8 : 0) | (o.magnetTimer > 0 ? 16 : 0);
const rosterOf = e => [e.id, e.name, e.skin === undefined ? -1 : e.skin, e.boss ? 1 : 0];

function spawnHuman(h) {
  const A = sim, me = A.makeEntity(0, 0, 5, "#0af", "#fff", 270);
  let p = A.zoneRandomPoint();
  for (let i = 0; i < 25; i++) {
    p = A.zoneRandomPoint();
    if (!A.blockedAt(p[0], p[1], 80) && A.enemies.every(e => !e.alive || Math.hypot(e.x - p[0], e.y - p[1]) > 600)) break;
  }
  const sk = A.SKINS[h.skin];
  Object.assign(me, { x: p[0], y: p[1], human: true, id: h.id, name: h.name, skin: h.skin, color: sk.color, innerColor: sk.inner, bladeCols: sk.blade, shieldTimer: 4, inx: 0, iny: 0, born: A.clock });
  const old = A.enemies.indexOf(h.ent); if (old >= 0) A.enemies.splice(old, 1);
  A.enemies.push(me); h.ent = me; h.dead = false; h.in = [0, 0];
}
function sendInit(h) {
  const A = sim;
  send(h, { t: "init", id: h.id, n: +A.clock.toFixed(2), zcx: A.zone.cx, zcy: A.zone.cy, obs: A.obstacles.map(o => Object.assign({}, o)),
    roster: A.enemies.filter(e => e.id !== undefined).map(rosterOf) });
}
function newRound() {
  const winner = [...humans.values()].filter(h => h.ent).sort((a, b) => (b.best || 0) - (a.best || 0))[0];
  sim = newSim(); roundEnd = ROUND_END;
  for (const h of humans.values()) { h.ent = null; h.best = 0; spawnHuman(h); sendInit(h); }
  sim.EV.push(["b", "🏁 Nueva partida" + (winner && winner.best ? " · Mejor de la anterior: " + winner.name + " (" + winner.best + " pts)" : ""), "#ffe066"]);
}

const GLOBAL_EV = { f: 1, b: 1, al: 1, bo: 1 };
function tick() {
  if (!humans.size) return;
  const A = sim;
  try {
    for (const h of humans.values()) if (h.ent && h.ent.alive) { h.ent.inx = h.in[0]; h.ent.iny = h.in[1]; }
    A.update(TICK_MS / 1000);
  } catch (e) { console.error("Error en la simulación:", e); newRound(); return; }
  tickN++;
  for (const e of A.enemies) if (e.id === undefined) { e.id = nextEid++; broadcast({ t: "ent", r: rosterOf(e) }); }   // p. ej. el Rey Rex
  for (const h of humans.values()) {
    if (h.ent && h.ent.alive) h.best = Math.max(h.best || 0, score(h.ent));
    if (h.ent && !h.ent.alive && !h.dead) {
      h.dead = true;
      send(h, { t: "dead", msg: h.ent.deathMsg || "Fuiste eliminado", score: score(h.ent), kills: h.ent.kills, peak: h.ent.peak, time: Math.max(0, Math.floor(A.clock - h.ent.born)) });
    }
  }
  // final de la partida: si ya no queda nadie vivo en los últimos 15 s, termina en 3 s
  if (A.clock >= LOCK_AT && roundEnd > A.clock + 3 && ![...humans.values()].some(h => h.ent && h.ent.alive)) roundEnd = A.clock + 3;
  // datos compartidos por todos los jugadores
  const alive = A.enemies.filter(e => e.alive);
  const saws = A.obstacles.filter(o => o.type === "saw").map(o => [Math.round(o.x), Math.round(o.y)]);
  const mets = A.meteors.map(m => [Math.round(m.x), Math.round(m.y), Math.round(m.r), +m.t.toFixed(2)]);
  const mm = tickN % 10 === 0 ? alive.map(e => [Math.round(e.x), Math.round(e.y), e.blades, e.boss ? 1 : 0]) : null;
  const evs = A.EV.slice(0, 80);
  for (const h of humans.values()) {
    const me = h.ent; if (!me) continue;
    const near = (x, y) => Math.abs(x - me.x) < 1500 && Math.abs(y - me.y) < 1100;
    const msg = { t: "s", n: +A.clock.toFixed(2), r: Math.max(0, Math.ceil(roundEnd - A.clock)), a: alive.length, o: humans.size, sw: saws, mt: mets,
      e: alive.filter(o => near(o.x, o.y)).map(o => [o.id, Math.round(o.x), Math.round(o.y), o.blades, flags(o)]) };
    if ((tickN + h.id) % 4 === 0) {            // espadas y orbes cercanos: 5 veces por segundo
      msg.k = A.knives.filter(k => near(k.x, k.y)).map(k => [Math.round(k.x), Math.round(k.y)]);
      msg.p = A.powerups.filter(p => near(p.x, p.y)).map(p => [Math.round(p.x), Math.round(p.y), ["speed", "shield", "magnet"].indexOf(p.type)]);
    }
    if (mm) msg.mm = mm;
    send(h, msg);
    const l = evs.filter(v => GLOBAL_EV[v[0]] || near(v[1], v[2]));
    if (l.length) send(h, { t: "ev", l });
  }
  A.EV.length = 0;
  if (A.clock > roundEnd) newRound();
}
setInterval(tick, TICK_MS);

/* ---------- Conexiones ---------- */
const wss = new WebSocketServer({ server: web, maxPayload: 1024 });
wss.on("connection", ws => {
  const h = { ws, id: nextHid++, ent: null, dead: false, in: [0, 0], joined: false, msgs: 0, best: 0 };
  const rate = setInterval(() => { h.msgs = 0; }, 1000);
  ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", raw => {
    if (++h.msgs > 60) return;                 // límite contra abusos
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === "join" && !h.joined) {
      if (humans.size >= MAX_PLAYERS) { send(h, { t: "err", msg: "El servidor está lleno. Intenta en un momento." }); return ws.close(); }
      const v = sim.validateNick(String(m.name || ""));
      if (!v.ok) { send(h, { t: "err", msg: v.msg }); return ws.close(); }
      h.name = v.nick; h.skin = Math.max(0, Math.min(sim.SKINS.length - 1, m.skin | 0)); h.joined = true;
      if (!humans.size) { sim = newSim(); roundEnd = ROUND_END; }   // primera persona: partida nueva
      humans.set(h.id, h); spawnHuman(h); sendInit(h);
      broadcast({ t: "ent", r: rosterOf(h.ent) }, h);
      sim.EV.push(["f", h.name + " entró a la arena", "#9fd8ff"]);
    } else if (m.t === "in" && h.joined) {
      const x = +m.x, y = +m.y;
      if (isFinite(x) && isFinite(y)) h.in = [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))];
    } else if (m.t === "respawn" && h.joined && h.dead && sim.clock < LOCK_AT) { spawnHuman(h); send(h, { t: "spawn" }); }
  });
  ws.on("close", () => {
    clearInterval(rate);
    if (!h.joined) return;
    const i = sim.enemies.indexOf(h.ent); if (i >= 0) sim.enemies.splice(i, 1);
    humans.delete(h.id);
    sim.EV.push(["f", h.name + " salió", "#bbb"]);
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);

process.on("uncaughtException", e => console.error("Error:", e));
web.listen(PORT, () => console.log("Dino Blades en línea escuchando en el puerto " + PORT + " (" + BOTS + " bots, máx. " + MAX_PLAYERS + " jugadores)"));
