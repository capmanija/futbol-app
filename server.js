import express from "express";
import cors from "cors";
import morgan from "morgan";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DATABASE_FILE || path.join(process.cwd(), "data.sqlite");

// --- DB ---
const firstTime = !fs.existsSync(DB_FILE);
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

if (firstTime) {
  db.exec(`
    CREATE TABLE matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipo_local TEXT NOT NULL,
      equipo_visitante TEXT NOT NULL,
      goles_favor_loc INTEGER NOT NULL DEFAULT 0,
      goles_favor_vis INTEGER NOT NULL DEFAULT 0,
      cancha TEXT NOT NULL,
      fecha TEXT NOT NULL, -- YYYY-MM-DD
      hora TEXT NOT NULL,  -- HH:mm
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      team TEXT NOT NULL CHECK(team IN ('local','visitante')),
      jugador TEXT NOT NULL,
      minuto INTEGER NOT NULL,
      penalty INTEGER NOT NULL DEFAULT 0,
      own_goal INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      team TEXT NOT NULL CHECK(team IN ('local','visitante')),
      jugador TEXT NOT NULL,
      minuto INTEGER NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('amarilla','roja'))
    );
  `);
}

// Helpers
const toBool = (n) => !!Number(n);
const mapMatch = (row) => ({
  id: row.id,
  equipo_local: row.equipo_local,
  equipo_visitante: row.equipo_visitante,
  goles_favor_loc: row.goles_favor_loc,
  goles_favor_vis: row.goles_favor_vis,
  cancha: row.cancha,
  fecha: row.fecha,
  hora: row.hora,
});

function fetchDetails(matchId) {
  const goals = db
    .prepare("SELECT * FROM goals WHERE match_id = ? ORDER BY minuto, id")
    .all(matchId)
    .map((g) => ({
      id: g.id,
      team: g.team,
      jugador: g.jugador,
      minuto: g.minuto,
      penalty: toBool(g.penalty),
      own_goal: toBool(g.own_goal),
    }));
  const cards = db
    .prepare("SELECT * FROM cards WHERE match_id = ? ORDER BY minuto, id")
    .all(matchId)
    .map((c) => ({
      id: c.id,
      team: c.team,
      jugador: c.jugador,
      minuto: c.minuto,
      tipo: c.tipo,
    }));
  return { goals, cards };
}

// --- App ---
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

// (Opcional) Servir el frontend estático si lo colocás en /public
const publicDir = path.join(process.cwd(), "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// Validación mínima
function validateMatch(payload) {
  const required = ["equipo_local","equipo_visitante","cancha","fecha","hora"];
  for (const k of required) if (!payload?.[k]) return `Falta: ${k}`;
  if (payload.goles_favor_loc < 0 || payload.goles_favor_vis < 0) return "Goles no pueden ser negativos";
  const okTeam = (t) => t === "local" || t === "visitante";
  if (payload.goles && !Array.isArray(payload.goles)) return "goles debe ser array";
  if (payload.tarjetas && !Array.isArray(payload.tarjetas)) return "tarjetas debe ser array";
  for (const g of payload.goles || []) {
    if (!okTeam(g.team)) return "team inválido en goles";
    if (!g.jugador) return "jugador requerido en goles";
    if (g.minuto == null || g.minuto < 0) return "minuto inválido en goles";
  }
  for (const c of payload.tarjetas || []) {
    if (!okTeam(c.team)) return "team inválido en tarjetas";
    if (!c.jugador) return "jugador requerido en tarjetas";
    if (c.minuto == null || c.minuto < 0) return "minuto inválido en tarjetas";
    if (!["amarilla","roja"].includes(c.tipo)) return "tipo inválido en tarjetas";
  }
  return null;
}

// --- Rutas ---
app.get("/api/health", (req,res)=> res.json({ ok:true }));

app.get("/api/matches", (req,res)=>{
  const rows = db.prepare("SELECT * FROM matches ORDER BY fecha DESC, hora DESC, id DESC").all();
  const base = rows.map(mapMatch);
  // Opcional: agregar un summary en cada item (contadores)
  const results = base.map((m) => {
    const gc = db.prepare("SELECT COUNT(1) AS c FROM goals WHERE match_id=?").get(m.id).c;
    const cc = db.prepare("SELECT COUNT(1) AS c FROM cards WHERE match_id=?").get(m.id).c;
    return { ...m, goles: [], tarjetas: [], _counts: { goles: gc, tarjetas: cc } };
  });
  res.json(results);
});

app.get("/api/matches/:id", (req,res)=>{
  const row = db.prepare("SELECT * FROM matches WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const match = mapMatch(row);
  const { goals, cards } = fetchDetails(match.id);
  res.json({ ...match, goles: goals, tarjetas: cards });
});

app.post("/api/matches", (req,res)=>{
  const err = validateMatch(req.body);
  if (err) return res.status(400).json({ error: err });

  const ins = db.prepare(`
    INSERT INTO matches (equipo_local, equipo_visitante, goles_favor_loc, goles_favor_vis, cancha, fecha, hora)
    VALUES (@equipo_local, @equipo_visitante, @goles_favor_loc, @goles_favor_vis, @cancha, @fecha, @hora)
  `);
  const tx = db.transaction((payload) => {
    const { lastInsertRowid } = ins.run(payload);
    const gIns = db.prepare(`
      INSERT INTO goals (match_id, team, jugador, minuto, penalty, own_goal)
      VALUES (@match_id, @team, @jugador, @minuto, @penalty, @own_goal)
    `);
    const cIns = db.prepare(`
      INSERT INTO cards (match_id, team, jugador, minuto, tipo)
      VALUES (@match_id, @team, @jugador, @minuto, @tipo)
    `);
    for (const g of payload.goles || []) {
      gIns.run({ match_id: lastInsertRowid, ...g, penalty: g.penalty?1:0, own_goal: g.own_goal?1:0 });
    }
    for (const c of payload.tarjetas || []) {
      cIns.run({ match_id: lastInsertRowid, ...c });
    }
    return lastInsertRowid;
  });

  const id = tx(req.body);
  const match = mapMatch(db.prepare("SELECT * FROM matches WHERE id=?").get(id));
  const { goals, cards } = fetchDetails(id);
  res.status(201).json({ ...match, goles: goals, tarjetas: cards });
});

app.put("/api/matches/:id", (req,res)=>{
  const err = validateMatch(req.body);
  if (err) return res.status(400).json({ error: err });

  const tx = db.transaction((payload, id)=>{
    const upd = db.prepare(`
      UPDATE matches SET
        equipo_local=@equipo_local,
        equipo_visitante=@equipo_visitante,
        goles_favor_loc=@goles_favor_loc,
        goles_favor_vis=@goles_favor_vis,
        cancha=@cancha,
        fecha=@fecha,
        hora=@hora
      WHERE id=@id
    `);
    upd.run({ ...payload, id });

    db.prepare("DELETE FROM goals WHERE match_id=?").run(id);
    db.prepare("DELETE FROM cards WHERE match_id=?").run(id);

    const gIns = db.prepare(`
      INSERT INTO goals (match_id, team, jugador, minuto, penalty, own_goal)
      VALUES (@match_id, @team, @jugador, @minuto, @penalty, @own_goal)
    `);
    const cIns = db.prepare(`
      INSERT INTO cards (match_id, team, jugador, minuto, tipo)
      VALUES (@match_id, @team, @jugador, @minuto, @tipo)
    `);
    for (const g of payload.goles || []) {
      gIns.run({ match_id: id, ...g, penalty: g.penalty?1:0, own_goal: g.own_goal?1:0 });
    }
    for (const c of payload.tarjetas || []) {
      cIns.run({ match_id: id, ...c });
    }
  });

  tx(req.body, Number(req.params.id));
  const match = mapMatch(db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id));
  const { goals, cards } = fetchDetails(match.id);
  res.json({ ...match, goles: goals, tarjetas: cards });
});

app.delete("/api/matches/:id", (req,res)=>{
  const id = Number(req.params.id);
  const del = db.prepare("DELETE FROM matches WHERE id = ?");
  const info = del.run(id);
  if (info.changes === 0) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

app.listen(PORT, ()=> {
  console.log(`API lista en http://localhost:${PORT}`);
  if (fs.existsSync(publicDir)) {
    console.log(`Frontend servido en http://localhost:${PORT}`);
  }
});

