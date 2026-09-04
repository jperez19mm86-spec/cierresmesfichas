/* ══════ EL DIARIO DE MI CAJA ══════

   Anota cada pedido que entra: quién, qué hizo, cuánto tardó y si falló. Los últimos 500, en
   memoria.

   Para qué: los registros del servidor sirven para «se cayó»; no sirven para «¿por qué a Juan le
   tardó nueve segundos cargar fichas el martes?». Esto último es lo que hace falta cuando cinco
   personas están usando el sistema de verdad y lo que vuelve es «no me anduvo».

   🔴 TIENE LOGINS Y MONTOS. Se lee sólo con la clave de `DIARIO_CLAVE`, que se pone a mano en el
      servidor. Sin esa variable la dirección NO EXISTE — contesta 404, igual que cualquier ruta
      inventada, para no anunciar que hay algo detrás.

   🔴 SOBREVIVE AL DESPLIEGUE. Antes vivía sólo en memoria, y eso lo volvía inútil justo cuando
      más se usa: durante la semana de pruebas se despliega varias veces por día, y cada despliegue
      se llevaba el diario entero. El 4-sep-2026 el equipo reportó un error con el número E-991 y
      cuando fui a buscarlo ya no existía — había desplegado tres veces en el medio. Un número de
      caso que no se puede consultar no sirve para nada.
      Ahora cada línea se guarda en la base, y al arrancar se recuperan las últimas. Sigue sin ser
      un registro contable ni un reemplazo de los movimientos del casino: es una lupa, y se borra
      sola a los 7 días.

   ⚠️ Para que sobreviva de verdad, el servicio necesita un VOLUMEN. Sin él la base misma es
      efímera —`[DB] base en: /app/data/store.sqlite (local/efímero)` en el arranque— y esto no
      cambia nada. El código funciona igual con base efímera; simplemente no persiste.

   Lo que NO se anota, nunca: contraseñas, ni el cuerpo entero de un pedido. Sólo los campos que
   sirven para entender qué pasó.                                                                 */

const TOPE = 500;
const DIAS_QUE_SE_GUARDA = 7;

/* La base es opcional a propósito: si por lo que sea no se puede abrir, el diario sigue andando en
   memoria como antes. Anotar no puede tumbar el sistema que está anotando. */
let db = null;
try {
  db = require('../db').db;
  db.exec(`CREATE TABLE IF NOT EXISTS caja_diario (
    n INTEGER PRIMARY KEY,
    cuando TEXT NOT NULL,
    ruta TEXT, metodo TEXT, quien TEXT, nivel TEXT,
    estado INTEGER, ms INTEGER, error TEXT,
    detalle TEXT, resultado TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS caja_diario_cuando ON caja_diario(cuando)');
} catch (e) {
  console.warn('[caja] el diario no pudo abrir la base, queda sólo en memoria:', e.message);
  db = null;
}

/* Circular a propósito: entra uno, sale el más viejo. Sin límite, una jornada larga se come la
   memoria del servicio — que es justo lo que no queremos que pase en producción. */
const anotados = [];
let numero = 0;

/* 🔴 EL NÚMERO NO PUEDE VOLVER A EMPEZAR EN 1. Si se reiniciara en cada despliegue, «me salió
   E-347» dejaría de identificar un caso: habría varios E-347 de días distintos, y el que se busca
   no sería el que aparece. Sigue desde el último que quedó guardado. */
function arrancar() {
  if (!db) return;
  try {
    const ultimo = db.prepare('SELECT MAX(n) AS n FROM caja_diario').get();
    numero = Number(ultimo && ultimo.n) || 0;
    /* Se traen las últimas para poder consultar un caso de antes del despliegue, que es todo el
       motivo de esto. Las viejas se limpian acá y no en cada anotación. */
    const filas = db.prepare(
      'SELECT * FROM caja_diario ORDER BY n DESC LIMIT ?').all(TOPE).reverse();
    for (const f of filas) {
      anotados.push({
        n: f.n, cuando: f.cuando, ruta: f.ruta, metodo: f.metodo, quien: f.quien, nivel: f.nivel,
        estado: f.estado, ms: f.ms, error: f.error,
        detalle: f.detalle ? JSON.parse(f.detalle) : null,
        resultado: f.resultado ? JSON.parse(f.resultado) : null,
      });
    }
    const corte = new Date(Date.now() - DIAS_QUE_SE_GUARDA * 86400000).toISOString();
    db.prepare('DELETE FROM caja_diario WHERE cuando < ?').run(corte);
    if (numero) console.log(`[caja] diario recuperado: ${filas.length} casos, sigue en E-${numero + 1}`);
  } catch (e) {
    console.warn('[caja] no se pudo recuperar el diario:', e.message);
  }
}
arrancar();

let guardarFila = null;
if (db) {
  try {
    guardarFila = db.prepare(`INSERT OR REPLACE INTO caja_diario
      (n, cuando, ruta, metodo, quien, nivel, estado, ms, error, detalle, resultado)
      VALUES (@n, @cuando, @ruta, @metodo, @quien, @nivel, @estado, @ms, @error, @detalle, @resultado)`);
  } catch (e) { guardarFila = null; }
}

/* 🔴 EL NÚMERO SE DA AL ENTRAR, NO AL SALIR. Se manda de vuelta en una cabecera para que la
   pantalla lo pueda mostrar cuando algo falla: así el operador dice «me salió E-347» y acá se ve
   quién fue, qué apretó, con qué monto y qué contestó el casino — sin que tenga que describir
   nada. Si se numerara al terminar, la respuesta ya habría salido sin el número. */
const siguienteCaso = () => { numero += 1; return numero; };

function anotar(fila) {
  anotados.push(fila);
  if (anotados.length > TOPE) anotados.shift();
  if (!guardarFila) return;
  /* Escribir no puede romper un pedido: si falla, se pierde esa línea y el sistema sigue. */
  try {
    guardarFila.run({
      n: fila.n, cuando: fila.cuando, ruta: fila.ruta, metodo: fila.metodo,
      quien: fila.quien || null, nivel: fila.nivel || null,
      estado: fila.estado, ms: fila.ms, error: fila.error || null,
      detalle: fila.detalle ? JSON.stringify(fila.detalle) : null,
      resultado: fila.resultado ? JSON.stringify(fila.resultado) : null,
    });
  } catch (e) { /* una línea perdida no vale una caída */ }
}

/* De lo que mueve fichas se guarda algo más: sin el monto y la cuenta, «falló una carga» no
   alcanza para entender nada. */
function delCuerpo(ruta, cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  if (ruta.endsWith('/fichas')) {
    return {
      cuenta: cuerpo.cuenta, operacion: cuerpo.operacion,
      monto: cuerpo.todo ? 'TODO' : cuerpo.monto, gesto: cuerpo.gesto,
    };
  }
  if (ruta.endsWith('/crear') || ruta.endsWith('/eliminar')) {
    return { login: cuerpo.login, tipo: cuerpo.tipo, cuenta: cuerpo.cuenta };
  }
  return null;
}

function medidor() {
  return function medir(req, res, siguiente) {
    if (!req.path.startsWith('/api/caja/')) return siguiente();
    if (req.path === '/api/caja/_diario') return siguiente();   // no se anota a sí mismo

    const arranque = Date.now();
    const caso = siguienteCaso();
    try { res.setHeader('X-Caso', String(caso)); } catch (e) { /* si ya salió, no importa */ }
    const jsonOriginal = res.json.bind(res);
    let error = null;
    /* El mensaje de error vive en el cuerpo de la respuesta, no en el código HTTP: el motor
       contesta 200 con `ok:false` más seguido de lo que uno querría. */
    let resultado = null;
    res.json = (cuerpo) => {
      if (cuerpo && cuerpo.ok === false && cuerpo.error) error = String(cuerpo.error).slice(0, 160);
      /* 🔴 LO QUE PIDIÓ NO ES LO QUE PASÓ. Un movimiento puede contestar «bien» y haber movido otra
         cosa —o nada—. Sin esto, el diario dice «salió 200» y no alcanza para responder la única
         pregunta que importa cuando falta plata: cuánto se movió de verdad. Medido el 1-sep-2026
         persiguiendo una ficha de diferencia que el diario no supo explicar. */
      if (cuerpo && (cuerpo.movido != null || cuerpo.antes != null)) {
        resultado = { antes: cuerpo.antes, despues: cuerpo.despues, movido: cuerpo.movido };
      }
      return jsonOriginal(cuerpo);
    };

    res.on('finish', () => {
      try {
        anotar({
          n: caso,
          cuando: new Date().toISOString(),
          ruta: req.path.replace('/api/caja/', ''),
          metodo: req.method,
          quien: (req.caja && req.caja.login) || null,
          nivel: (req.caja && req.caja.rol) || null,
          estado: res.statusCode,
          ms: Date.now() - arranque,
          error,
          detalle: delCuerpo(req.path, req.body),
          resultado,
        });
      } catch (e) { /* anotar no puede romper un pedido: si falla, se pierde esa línea y ya */ }
    });

    siguiente();
  };
}

/* Un resumen por ruta, que es lo que se mira primero: cuántas veces, cuánto tarda normalmente y
   cuánto tarda cuando tarda. La mediana sola miente — el promedio de las peores es lo que sufre
   la persona que está esperando. */
function resumen(filas) {
  const porRuta = new Map();
  for (const f of filas) {
    if (!porRuta.has(f.ruta)) porRuta.set(f.ruta, { ruta: f.ruta, veces: 0, fallas: 0, ms: [] });
    const r = porRuta.get(f.ruta);
    r.veces += 1;
    if (f.error || f.estado >= 400) r.fallas += 1;
    r.ms.push(f.ms);
  }
  const percentil = (lista, p) => {
    const o = [...lista].sort((a, b) => a - b);
    return o[Math.min(o.length - 1, Math.floor((o.length - 1) * p))];
  };
  return [...porRuta.values()]
    .map((r) => ({
      ruta: r.ruta, veces: r.veces, fallas: r.fallas,
      medio: percentil(r.ms, 0.5), lento: percentil(r.ms, 0.95), peor: Math.max(...r.ms),
    }))
    .sort((a, b) => b.lento - a.lento);
}

function montar(app) {
  app.get('/api/caja/_diario', (req, res) => {
    const clave = process.env.DIARIO_CLAVE;
    /* Sin clave configurada la dirección no existe. Contestar «falta la clave» sería avisarle a
       cualquiera que acá hay algo que mirar. */
    if (!clave) return res.status(404).end();
    const dada = req.get('X-Diario') || req.query.clave || '';
    if (String(dada) !== String(clave)) return res.status(404).end();

    const q = req.query;
    let filas = anotados;
    /* Buscar UN caso por su número es lo primero que se hace cuando alguien reporta un error. */
    if (q.caso) filas = filas.filter((f) => String(f.n) === String(q.caso));
    if (q.quien) filas = filas.filter((f) => f.quien === q.quien);
    if (q.ruta) filas = filas.filter((f) => f.ruta.includes(String(q.ruta)));
    if (q.soloFallas === '1') filas = filas.filter((f) => f.error || f.estado >= 400);
    if (q.desdeMs) filas = filas.filter((f) => f.ms >= Number(q.desdeMs));

    const cuantas = Math.min(Number(q.limite) || 100, TOPE);
    res.json({
      ok: true,
      total: anotados.length,
      desde: anotados.length ? anotados[0].cuando : null,
      resumen: resumen(filas),
      filas: filas.slice(-cuantas),
    });
  });
}

module.exports = { medidor, montar, anotados };
