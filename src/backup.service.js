/**
 * backup.service.js — LA COPIA DE SEGURIDAD DE TODA LA BASE.
 *
 * ── QUÉ HABÍA ANTES ──────────────────────────────────────────────────────────────────────────
 * Dos cosas, y ninguna era una copia de seguridad:
 *   · `/api/_backup` exportaba TRES tablas (systems, clientes, pedidos) de las 44 que hay. Afuera
 *     quedaban los movimientos —o sea la cuenta corriente de los 45 clientes—, los comprobantes con
 *     sus fotos, la matriz del cierre, las participaciones, las facturas emitidas, el acumulado
 *     diario y los tipos de cambio históricos.
 *   · El botón "⤓ Bajar respaldo" de Importar planilla baja otras tres (clientes, paneles,
 *     divisas). Ése no está mal: es el deshacer de ESE import y hace bien su trabajo. Lo que estaba
 *     mal era que pareciera la copia de seguridad del sistema.
 *
 * Los tipos de cambio son el caso que decide todo: la cotización de un día que ya pasó NO se puede
 * volver a pedir. Todo lo demás se podría reconstruir a mano desde los paneles del casino, con
 * meses de trabajo. Eso no.
 *
 * ── POR QUÉ NO ALCANZA CON BAJAR store.sqlite DEL VOLUMEN ────────────────────────────────────
 * Es lo primero que uno piensa, y da una base VACÍA.
 *
 * La base corre en modo WAL (db.js:25). En WAL lo que se escribe no va al archivo principal: va a
 * un archivo aparte, `store.sqlite-wal`, y recién pasa al principal cuando SQLite hace un
 * checkpoint. Medido en esta misma base: 962 KB en el archivo principal y 4 MB en el WAL. Copiando
 * sólo `store.sqlite` de un volumen con actividad, la copia ni siquiera abre — las tablas no están.
 * Es la peor clase de respaldo: pesa, parece un archivo, y adentro no hay nada.
 * (test/smoke.js reproduce ese error a propósito, para que nadie "simplifique" esto copiando el
 * archivo.)
 *
 * ── POR QUÉ `db.backup()` Y NO `db.serialize()` ──────────────────────────────────────────────
 * `serialize()` era el camino corto y NO SIRVE ACÁ: sobre una base en WAL devuelve una imagen que
 * ya no se puede volver a abrir ("unable to open database file"), porque el modo WAL viaja en el
 * encabezado y una base WAL necesita sus archivos al lado. Se probó y falló contra esta misma base.
 *
 * `db.backup()` es el respaldo en caliente de SQLite: copia página por página mientras el sistema
 * sigue andando, deja el destino consistente y ya checkpointeado, y ese archivo abre solo.
 *
 * ── LA COPIA SE VERIFICA ANTES DE BAJARSE ────────────────────────────────────────────────────
 * Una copia rota es peor que ninguna: da tranquilidad y no sirve. Antes de mandarla se abre el
 * archivo generado, se le corre `integrity_check` y —esto es lo que de verdad prueba algo— se
 * cuentan las filas de CADA tabla y se comparan contra la base viva. Si una sola no coincide, no se
 * baja: se avisa cuál. Cuesta un segundo y sólo pasa cuando alguien aprieta el botón.
 *
 * ── ⚠️ ESTE ARCHIVO NO SE COMPARTE ───────────────────────────────────────────────────────────
 * Adentro van las contraseñas del casino. No es un descuido: la copia tiene que servir para
 * levantar el sistema en otro lado, y sin credenciales no levanta. Pero significa que el archivo va
 * a un disco propio y a ningún chat, Telegram, Drive compartido ni mail.
 *
 * Por eso mismo NO se manda solo a ningún lado. Un cron que lo subiera a Telegram sería la forma
 * más rápida de tener las llaves del negocio en una nube ajena para siempre.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');
const cfg = require('./config-store');

const CLAVE_ULTIMA = 'backupUltima';   // cuándo se bajó la última, para poder reclamarla

/** Las tablas de verdad. Las internas de SQLite viajan igual dentro del archivo. */
function tablas() {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name);
}

/** Filas por tabla, sobre la conexión que se le pase. Sirve para la base viva y para la copia. */
function _conteo(conn, nombres) {
  const o = {};
  // El nombre viene de sqlite_master, no de nadie de afuera; va entre comillas igual.
  for (const n of nombres) o[n] = conn.prepare(`SELECT COUNT(*) c FROM "${n}"`).get().c;
  return o;
}

/**
 * QUÉ HAY ADENTRO, TABLA POR TABLA.
 *
 * No es decoración: es lo único que deja comprobar de un vistazo que la copia trae todo. Un número
 * global ("44 tablas") no distingue una copia completa de una copia de tablas vacías.
 */
function inventario() {
  const nombres = tablas();
  const c = _conteo(db, nombres);
  const t = nombres.map((nombre) => ({ nombre, filas: c[nombre] }));
  const u = ultima();
  return {
    tablas: t,
    cuantasTablas: t.length,
    filas: t.reduce((s, x) => s + x.filas, 0),
    vacias: t.filter((x) => !x.filas).length,
    ultima: u,
    diasDesde: u ? Math.floor((Date.now() - Date.parse(u.cuando)) / 86400000) : null,
  };
}

/**
 * La base entera, verificada contra la base viva.
 *
 * @returns { buffer, bytes, nombre, control:{ tablas, filas } }
 * @throws si la copia no pasa el control — antes que entregar una copia que no sirve, no entregar
 *         ninguna y que se note.
 */
async function snapshot() {
  // Nombre único: dos descargas a la vez no se pisan el archivo temporal.
  const tmp = path.join(os.tmpdir(), `latam-os-bk-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  const limpiar = () => [tmp, tmp + '-wal', tmp + '-shm'].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });

  try {
    await db.backup(tmp);                       // respaldo en caliente: el sistema sigue andando

    const nombres = tablas();
    const vivo = _conteo(db, nombres);
    let control;
    const copia = new Database(tmp, { readonly: true });
    try {
      const chk = copia.pragma('integrity_check');
      if (!(chk && chk[0] && chk[0].integrity_check === 'ok')) {
        throw new Error('la copia no pasó el control de integridad: ' + JSON.stringify(chk));
      }
      const enCopia = copia.prepare(`SELECT name FROM sqlite_master WHERE type='table'
          AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
      const faltan = nombres.filter((n) => !enCopia.includes(n));
      if (faltan.length) throw new Error('a la copia le faltan tablas: ' + faltan.join(', '));

      // El control que de verdad prueba algo: mismas filas en la copia que en la base viva.
      const cop = _conteo(copia, nombres);
      const difieren = nombres.filter((n) => cop[n] !== vivo[n])
        .map((n) => `${n} (${cop[n]} vs ${vivo[n]})`);
      if (difieren.length) throw new Error('la copia no coincide con la base: ' + difieren.join(', '));

      control = { tablas: enCopia.length, filas: nombres.reduce((s, n) => s + cop[n], 0) };
    } finally { copia.close(); }

    const buffer = fs.readFileSync(tmp);
    if (!buffer.length) throw new Error('la copia salió vacía');
    return { buffer, bytes: buffer.length, nombre: nombreArchivo(), control };
  } finally { limpiar(); }
}

/** Un nombre que se ordena solo en la carpeta y dice de cuándo es sin abrirlo. */
function nombreArchivo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `latam-os-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}.sqlite`;
}

function ultima() {
  try { const v = cfg.getCfg(CLAVE_ULTIMA); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

/** Se anota DESPUÉS de mandarla. Anotarla antes contaría como bajada una descarga que se cortó. */
function registrar({ bytes, nombre }) {
  const dato = { cuando: new Date().toISOString(), bytes, nombre };
  cfg.setCfg(CLAVE_ULTIMA, JSON.stringify(dato));
  return dato;
}


/* ── EL RESPALDO EN JSON ──────────────────────────────────────────────────────────────────────
   Es el hermano legible del archivo .sqlite: sirve para mirar los datos sin abrir la base y para
   mudar de entorno. La copia de seguridad de verdad es el .sqlite de arriba.

   Estas dos funciones estaban escritas ADENTRO de la ruta, en index.js, y por eso no había forma de
   probarlas sin pegarle a la base de producción. Acá se les puede hacer la única prueba que
   importa: sacar el respaldo, volver a meterlo, y ver si quedó todo. */

/** Todas las tablas, leídas de la base. Nombrarlas a mano es cómo el respaldo viejo llegó a tres. */
function dumpTablas() {
  const o = {};
  for (const t of tablas()) o[t] = db.prepare(`SELECT * FROM "${t}"`).all();
  return o;
}

/**
 * Mete de vuelta un dump de tablas. TODO O NADA: a mitad de camino la base queda peor que antes.
 *
 * Las claves foráneas se apagan DENTRO de la transacción porque las tablas van en orden alfabético,
 * no en el de sus dependencias, y un hijo puede entrar antes que su padre.
 *
 * De cada tabla se usan sólo las columnas que existen en las dos puntas: un respaldo de una versión
 * anterior puede no tener una columna agregada después, y al revés.
 */
function restaurarTablas(dumpTablasObj) {
  const existentes = new Set(tablas());
  const aplicado = {};
  const avisos = [];
  const desconocidas = Object.keys(dumpTablasObj).filter((t) => !existentes.has(t));
  if (desconocidas.length) avisos.push('el respaldo trae datos que esta versión ya no usa: ' + desconocidas.join(', '));
  const noVienen = [...existentes].filter((t) => !Object.prototype.hasOwnProperty.call(dumpTablasObj, t));
  if (noVienen.length) avisos.push('el respaldo no trae: ' + noVienen.join(', '));

  const correr = db.transaction(() => {
    for (const t of Object.keys(dumpTablasObj)) {
      if (!existentes.has(t)) continue;
      const filas = dumpTablasObj[t];
      if (!Array.isArray(filas)) continue;
      db.prepare(`DELETE FROM "${t}"`).run();
      if (!filas.length) { aplicado[t] = 0; continue; }
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      const usar = cols.filter((c) => Object.prototype.hasOwnProperty.call(filas[0], c));
      const faltan = cols.filter((c) => !usar.includes(c));
      if (faltan.length) avisos.push(`${t}: sin datos para ${faltan.join(', ')}`);
      if (!usar.length) { avisos.push(`${t}: ninguna columna coincide, se salteó`); continue; }
      const ins = db.prepare(`INSERT INTO "${t}" (${usar.map((c) => `"${c}"`).join(',')})`
        + ` VALUES (${usar.map(() => '?').join(',')})`);
      for (const f of filas) ins.run(usar.map((c) => (f[c] === undefined ? null : f[c])));
      aplicado[t] = filas.length;
    }
  });
  db.pragma('foreign_keys = OFF');
  try { correr(); } finally { db.pragma('foreign_keys = ON'); }
  return { aplicado, avisos };
}

module.exports = { dumpTablas, restaurarTablas, inventario, snapshot, nombreArchivo, ultima, registrar, tablas, CLAVE_ULTIMA };
