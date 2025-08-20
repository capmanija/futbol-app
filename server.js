import express from "express";
import cors from "cors";
import morgan from "morgan";
import { Pool } from "pg";
import path from "node:path";
import fs from "node:fs";

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Falta la variable de entorno DATABASE_URL");
  process.exit(1);
}

// Forzar SSL compatible con Neon/Supabase
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // importante para Neon
});

async function ensureSchema() {
  const sql = `
  CREATE TABLE IF NOT EXISTS matches (
    id SERIAL PRIMARY KEY,
    equipo_local TEXT NOT NULL,
    equipo_visitante TEXT NOT NULL,
    goles_favor_loc INTEGER NOT NULL DEFAULT 0,
    goles_favor_vis INTEGER NOT NULL DEFAULT 0,
    cancha TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS goals (
    id SERIAL PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    team TEXT NOT NULL CHECK (team IN ('local','visitante')),
    jugador TEXT NOT NULL,
    minuto INTEGER NOT NULL,
    penalty BOOLEAN NOT NULL DEFAULT false,
    own_goal BOOLEAN NOT NULL DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS cards (
    id SERIAL PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    team TEXT NOT NULL CHECK (team IN ('local','visitante')),
    jugador TEXT NOT NULL,
    minuto INTEGER NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('amarilla','roja'))
  );
  `;
  await pool.query(sql);
}

// ---- diagnóstico de arranque ----
try {
  console.log("Probando conexión a la base...");
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();
  console.log("✅ Conexión OK");
} catch (e) {
  console.error("❌ Error conectando a Postgres:");
  console.error(e?.message || e);
  console.error(e?.stack);
  process.exit(1); // paramos acá para ver el error en logs
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

const publicDir = path.join(process.cwd(), "public");
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

// health básico
app.get("/api/health", (req, res) => res.json({ ok: true }));

// health de DB (para probar desde el navegador)
app.get("/api/health/db", async (req, res) => {
  try {
    const r = await pool.query("SELECT now()");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// helpers y rutas (idénticas a las que ya tenías)...
function mapMatch(row) {
  return {
    id: row.id,
    equipo_local: row.equipo_local,
    equipo_visitante: row.equipo_visitante,
    goles_favor_loc: row.goles_favor_loc,
    goles_favor_vis: row.goles_favor_vis,
    cancha: row.cancha,
    fecha: row.fecha,
    hora: row.hora,
  };
}
function validateMatch(p) {
  const required = ["equipo_local", "equipo_visitante", "cancha", "fecha", "hora"];
  for (const k of required) if (!p?.[k]) return `Falta: ${k}`;
  if (p.goles_favor_loc < 0 || p.goles_favor_vis < 0) return "Goles no pueden ser negativos";
  if (p.goles && !Array.isArray(p.goles)) return "goles debe ser array";
  if (p.tarjetas && !Array.isArray(p.tarjetas)) return "tarjetas debe ser array";
  const okTeam = (t) => t === "local" || t === "visitante";
  for (const g of p.goles || []) {
    if (!okTeam(g.team)) return "team inválido en goles";
    if (!g.jugador) return "jugador requerido en goles";
    if (g.minuto == null || g.minuto < 0) return "minuto inválido en goles";
  }
  for (const c of p.tarjetas || []) {
    if (!okTeam(c.team)) return "team inválido en tarjetas";
    if (!c.jugador) return "jugador requerido en tarjetas";
    if (c.minuto == null || c.minuto < 0) return "minuto inválido en tarjetas";
    if (!["amarilla", "roja"].includes(c.tipo)) return "tipo inválido en tarjetas";
  }
  return null;
}
async function fetchDetails(matchId) {
  const goals = (await pool.query(
    "SELECT * FROM goals WHERE match_id = $1 ORDER BY minuto, id",
    [matchId]
  )).rows.map(g => ({
    id: g.id, team: g.team, jugador: g.jugador, minuto: g.minuto,
    penalty: !!g.penalty, own_goal: !!g.own_goal
  }));
  const cards = (await pool.query(
    "SELECT * FROM cards WHERE match_id = $1 ORDER BY minuto, id",
    [matchId]
  )).rows.map(c => ({
    id: c.id, team: c.team, jugador: c.jugador, minuto: c.minuto, tipo: c.tipo
  }));
  return { goals, cards };
}

app.get("/api/matches", async (req, res, next) => {
  try {
    const rows = (await pool.query(
      "SELECT * FROM matches ORDER BY fecha DESC, hora DESC, id DESC"
    )).rows;
    const results = await Promise.all(rows.map(async (r) => {
      const gc = (await pool.query("SELECT COUNT(1) c FROM goals WHERE match_id=$1", [r.id])).rows[0].c;
      const cc = (await pool.query("SELECT COUNT(1) c FROM cards WHERE match_id=$1", [r.id])).rows[0].c;
      return { ...mapMatch(r), goles: [], tarjetas: [], _counts: { goles: Number(gc), tarjetas: Number(cc) } };
    }));
    res.json(results);
  } catch (e) { next(e); }
});

app.get("/api/matches/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM matches WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    const match = mapMatch(rows[0]);
    const { goals, cards } = await fetchDetails(match.id);
    res.json({ ...match, goles: goals, tarjetas: cards });
  } catch (e) { next(e); }
});

app.post("/api/matches", async (req, res, next) => {
  try {
    const err = validateMatch(req.body);
    if (err) return res.status(400).json({ error: err });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO matches (equipo_local, equipo_visitante, goles_favor_loc, goles_favor_vis, cancha, fecha, hora)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          req.body.equipo_local, req.body.equipo_visitante,
          req.body.goles_favor_loc ?? 0, req.body.goles_favor_vis ?? 0,
          req.body.cancha, req.body.fecha, req.body.hora,
        ]
      );
      const id = ins.rows[0].id;
      for (const g of req.body.goles || []) {
        await client.query(
          `INSERT INTO goals (match_id, team, jugador, minuto, penalty, own_goal)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, g.team, g.jugador, g.minuto, !!g.penalty, !!g.own_goal]
        );
      }
      for (const c of req.body.tarjetas || []) {
        await client.query(
          `INSERT INTO cards (match_id, team, jugador, minuto, tipo)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, c.team, c.jugador, c.minuto, c.tipo]
        );
      }
      await client.query("COMMIT");
      const match = (await pool.query("SELECT * FROM matches WHERE id=$1", [id])).rows[0];
      const { goals, cards } = await fetchDetails(id);
      res.status(201).json({ ...mapMatch(match), goles: goals, tarjetas: cards });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) { next(e); }
});

app.put("/api/matches/:id", async (req, res, next) => {
  try {
    const err = validateMatch(req.body);
    if (err) return res.status(400).json({ error: err });
    const id = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE matches SET
          equipo_local=$1, equipo_visitante=$2,
          goles_favor_loc=$3, goles_favor_vis=$4,
          cancha=$5, fecha=$6, hora=$7
         WHERE id=$8`,
        [
          req.body.equipo_local, req.body.equipo_visitante,
          req.body.goles_favor_loc ?? 0, req.body.goles_favor_vis ?? 0,
          req.body.cancha, req.body.fecha, req.body.hora, id
        ]
      );
      await client.query("DELETE FROM goals WHERE match_id=$1", [id]);
      await client.query("DELETE FROM cards WHERE match_id=$1", [id]);
      for (const g of req.body.goles || []) {
        await client.query(
          `INSERT INTO goals (match_id, team, jugador, minuto, penalty, own_goal)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, g.team, g.jugador, g.minuto, !!g.penalty, !!g.own_goal]
        );
      }
      for (const c of req.body.tarjetas || []) {
        await client.query(
          `INSERT INTO cards (match_id, team, jugador, minuto, tipo)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, c.team, c.jugador, c.minuto, c.tipo]
        );
      }
      await client.query("COMMIT");
      const match = (await pool.query("SELECT * FROM matches WHERE id=$1", [id])).rows[0];
      const { goals, cards } = await fetchDetails(id);
      res.json({ ...mapMatch(match), goles: goals, tarjetas: cards });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) { next(e); }
});

app.delete("/api/matches/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const info = await pool.query("DELETE FROM matches WHERE id=$1", [id]);
    if (info.rowCount === 0) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error("Middleware de error:", err?.message || err);
  res.status(500).json({ error: "server_error", detail: String(err?.message || err) });
});

await ensureSchema();

app.listen(PORT, () => {
  console.log(`API lista en http://localhost:${PORT}`);
  if (fs.existsSync(publicDir)) console.log(`Frontend servido en http://localhost:${PORT}`);
});
