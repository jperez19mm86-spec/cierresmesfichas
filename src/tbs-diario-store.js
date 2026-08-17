/**
 * tbs-diario-store.js — EL REPORTE DIARIO DE TBS, guardado día por día.
 *
 * Casino y Europa tienen su acumulado diario (`reporte_diario`) y de ahí sale el Pulso, el control
 * de la facturación y las tendencias. TBS no lo tenía: sólo se le podía preguntar por un rango, y
 * cada pregunta tarda ~54 segundos. Sin algo guardado, cualquier reporte diario del mes son 31
 * llamadas de 54s cada vez que alguien lo abre.
 *
 * ── POR QUÉ UNA TABLA APARTE Y NO `reporte_diario` ───────────────────────────────────────────
 * Porque NO son las mismas cantidades. En el motor 463 se guarda `in` / `out`: fichas cargadas y
 * retiradas. En TBS lo que hay es `bet` / `win`: lo apostado y lo ganado por los jugadores. Meter
 * bet en la columna `in` haría que el Pulso —que lee esa tabla— sume apuestas como si fueran
 * cargas, y ninguna pantalla lo delataría. Ya pasó algo así con los espejos de carga: dos meses
 * contando doble sin que se notara.
 *
 * El profit NO viene del panel: es `bet − win`, y se guarda calculado para no recalcularlo en cada
 * lectura ni depender de que quien lea se acuerde de la fórmula.
 *
 * ── LA GRANULARIDAD, Y POR QUÉ NO ES MÁS FINA ────────────────────────────────────────────────
 * Se guarda por DÍA × AGENTE × MONEDA, sumando todos los grupos de proveedores. Por grupo sería
 * más útil, pero TBS devuelve un árbol por llamada y filtrar por grupo obliga a una llamada por
 * grupo: 52 grupos × 31 días × 54s ≈ 24 horas por mes. Con todos los grupos juntos es una llamada
 * por día — 31 llamadas, ~28 minutos — y alcanza para el reporte diario, que es lo que se pidió.
 * El desglose por proveedor sigue estando en el Pago a proveedores, que es mensual.
 */
const crypto = require('crypto');
const { db, ensureColumns } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tbs_diario (
    id TEXT PRIMARY KEY,
    fecha TEXT,                  -- YYYY-MM-DD (el día tal como lo entiende TBS)
    agente_id TEXT,              -- id del nodo en TBS; 'TOTAL' = el árbol entero
    login TEXT,
    moneda TEXT,
    bet TEXT, win TEXT, profit TEXT,
    salas INTEGER,
    ms INTEGER,                  -- cuánto tardó ESA captura: la estimación sale de acá, no de una constante
    captured_at TEXT
  );
  /* Un día se puede volver a capturar —el panel corrige datos de días pasados— y tiene que
     REEMPLAZAR, no sumarse. El índice único es lo que hace que el upsert sea posible. */
  CREATE UNIQUE INDEX IF NOT EXISTS ux_tbs_diario
    ON tbs_diario (fecha, agente_id, moneda);
  CREATE INDEX IF NOT EXISTS idx_tbs_diario_mes ON tbs_diario (substr(fecha,1,7));
`);
// La tabla puede existir de antes de que `ms` existiera: CREATE IF NOT EXISTS no agrega columnas.
ensureColumns('tbs_diario', { ms: 'INTEGER' });

const nowISO = () => new Date().toISOString();
const S = (x) => (x === null || x === undefined ? null : String(x));

/**
 * Guarda (o reemplaza) las filas de UN día.
 *
 * @param filas  [{ agente_id, login, moneda, bet, win, profit, salas }]
 * @returns cuántas filas quedaron guardadas
 *
 * Todo el día se reemplaza en una transacción: si se cortara a mitad, el día quedaría con la mitad
 * vieja y la mitad nueva, que es peor que no haberlo tocado.
 */
const _guardar = db.transaction((fecha, filas, ms) => {
  db.prepare('DELETE FROM tbs_diario WHERE fecha=?').run(String(fecha));
  const ins = db.prepare(`INSERT INTO tbs_diario
    (id,fecha,agente_id,login,moneda,bet,win,profit,salas,ms,captured_at)
    VALUES (@id,@fecha,@ag,@login,@mon,@bet,@win,@profit,@salas,@ms,@at)`);
  let n = 0;
  for (const f of filas || []) {
    ins.run({
      id: 'tbsd_' + crypto.randomBytes(6).toString('hex'),
      fecha: String(fecha), ag: S(f.agente_id) || 'TOTAL', login: S(f.login) || '',
      mon: S(f.moneda) || '?', bet: S(f.bet) || '0', win: S(f.win) || '0',
      profit: S(f.profit) || '0', salas: Number(f.salas) || 0,
      ms: Number(ms) || null, at: nowISO(),
    });
    n += 1;
  }
  return n;
});
function guardarDia(fecha, filas, ms) { return _guardar(fecha, filas, ms); }

/**
 * Cuánto tarda un día, MEDIDO.
 *
 * La primera versión estimaba con una constante de 54 segundos, sacada de una consulta de un MES
 * entero. Un día solo pesa mucho menos: el primero tardó 3 segundos. Con la constante, el mes daba
 * 28 minutos y la respuesta razonable era no hacerlo — cuando en realidad son un par de minutos.
 * Una estimación mal calibrada no es un detalle: cambia la decisión.
 */
function msPromedio() {
  const r = db.prepare('SELECT AVG(ms) a FROM (SELECT DISTINCT fecha, ms FROM tbs_diario WHERE ms > 0)').get();
  return Math.round((r && r.a) || 0) || null;
}

/** Qué días del mes ya están capturados. Es lo que permite retomar sin repetir 54s por día. */
function diasCapturados(mes) {
  return db.prepare("SELECT DISTINCT fecha FROM tbs_diario WHERE substr(fecha,1,7)=? ORDER BY fecha")
    .all(String(mes || '').slice(0, 7)).map((r) => r.fecha);
}

/**
 * El mes entero: filas por día, y los totales por moneda.
 *
 * `agente_id='TOTAL'` es el árbol completo; el resto son los nodos que se facturan. Se devuelven
 * separados porque sumar los dos juntos contaría todo dos veces.
 */
function delMes(mes) {
  const m = String(mes || '').slice(0, 7);
  const filas = db.prepare(`SELECT fecha, agente_id, login, moneda, bet, win, profit, salas
    FROM tbs_diario WHERE substr(fecha,1,7)=? ORDER BY fecha ASC, login ASC`).all(m);
  const totales = {};
  filas.filter((f) => f.agente_id === 'TOTAL').forEach((f) => {
    const t = totales[f.moneda] = totales[f.moneda] || { bet: 0, win: 0, profit: 0 };
    t.bet += Number(f.bet) || 0; t.win += Number(f.win) || 0; t.profit += Number(f.profit) || 0;
  });
  return {
    mes: m,
    dias: [...new Set(filas.map((f) => f.fecha))],
    total: filas.filter((f) => f.agente_id === 'TOTAL'),
    porAgente: filas.filter((f) => f.agente_id !== 'TOTAL'),
    totalesPorMoneda: totales,
  };
}

/** Borra un día. Para rehacerlo cuando el panel corrigió datos viejos. */
function borrarDia(fecha) {
  return db.prepare('DELETE FROM tbs_diario WHERE fecha=?').run(String(fecha)).changes;
}

module.exports = { guardarDia, diasCapturados, delMes, borrarDia, msPromedio };
