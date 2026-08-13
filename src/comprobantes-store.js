/**
 * comprobantes-store.js — COMPROBANTES DE PAGO que suben los clientes.
 *
 * El cliente entra con su código y elige un camino: pedir fichas (lo de siempre) o AVISAR UN PAGO.
 * Acá vive el segundo: el cliente declara cuánto transfirió, a qué cuenta, y adjunta la captura.
 *
 * Queda PENDIENTE hasta que alguien lo mira. No toca la deuda solo: acreditar un pago porque el
 * cliente subió una imagen sería confiar en la imagen. Se aprueba a mano y recién ahí se registra
 * el movimiento — que es el único que mueve el saldo.
 *
 * El archivo se guarda EN LA BASE, no en disco: la base ya vive en el volumen de Railway y así el
 * comprobante y su registro no se pueden separar (un archivo huérfano o un registro sin archivo
 * serían peores que no tenerlo).
 */
const { db } = require('./db');

const nowISO = () => new Date().toISOString();
const K = (s) => String(s == null ? '' : s).trim();
const newId = () => 'cmp_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Tope del adjunto. Una captura de pantalla pesa bastante menos; más que esto es otra cosa. */
const MAX_BYTES = 6 * 1024 * 1024;

const ESTADOS = ['pendiente', 'aprobado', 'rechazado'];

/**
 * Alta desde la pantalla pública.
 * @param archivo { nombre, tipo, base64 }  opcional
 */
function crear({ codigo, clienteNombre, via, monto, divisa, referencia, notas, archivo = null }) {
  const v = K(via).toLowerCase() === 'usdt' ? 'usdt' : 'ars';
  const m = String(monto || '').replace(/\./g, '').replace(',', '.');
  if (!(Number(m) > 0)) return { ok: false, error: 'el monto no es válido' };

  let bytes = 0; let datos = null; let nombre = null; let tipo = null;
  if (archivo && archivo.base64) {
    const limpio = String(archivo.base64).replace(/^data:[^;]+;base64,/, '');
    bytes = Math.floor(limpio.length * 0.75);
    if (bytes > MAX_BYTES) return { ok: false, error: `el archivo pesa ${(bytes / 1048576).toFixed(1)} MB y el máximo son ${MAX_BYTES / 1048576} MB` };
    datos = limpio; nombre = K(archivo.nombre).slice(0, 120); tipo = K(archivo.tipo).slice(0, 60);
  }

  const id = newId();
  db.prepare(`INSERT INTO comprobantes
    (id, codigo, cliente_nombre, via, monto, divisa, referencia, notas, estado,
     archivo_nombre, archivo_tipo, archivo_bytes, archivo_datos, creado_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, K(codigo), K(clienteNombre), v, m, v === 'usdt' ? 'USDT' : K(divisa || 'ARS').toUpperCase(),
      K(referencia).slice(0, 120), K(notas).slice(0, 500), 'pendiente',
      nombre, tipo, bytes, datos, nowISO());
  return { ok: true, comprobante: get(id) };
}

/** Sin el adjunto: es lo que se lista. Traerlo en cada listado sería mover megas al pedo. */
function get(id, conArchivo = false) {
  const cols = `id, codigo, cliente_nombre, via, monto, divisa, referencia, notas, estado,
    archivo_nombre, archivo_tipo, archivo_bytes, creado_at, resuelto_at, resuelto_por, motivo, movimiento_id
    ${conArchivo ? ', archivo_datos' : ''}`;
  return db.prepare(`SELECT ${cols} FROM comprobantes WHERE id=?`).get(String(id)) || null;
}

function list({ estado = null, codigo = null, limite = 200 } = {}) {
  const donde = []; const args = [];
  if (estado) { donde.push('estado=?'); args.push(String(estado)); }
  if (codigo) { donde.push('codigo=?'); args.push(String(codigo)); }
  const w = donde.length ? 'WHERE ' + donde.join(' AND ') : '';
  return db.prepare(`SELECT id, codigo, cliente_nombre, via, monto, divisa, referencia, notas, estado,
    archivo_nombre, archivo_tipo, archivo_bytes, creado_at, resuelto_at, resuelto_por, motivo, movimiento_id,
    aviso_ok, aviso_error, aviso_at
    FROM comprobantes ${w} ORDER BY creado_at DESC LIMIT ?`).all(...args, Number(limite) || 200);
}

function cuentas() {
  const r = db.prepare("SELECT estado, COUNT(*) c FROM comprobantes GROUP BY estado").all();
  const out = { pendiente: 0, aprobado: 0, rechazado: 0 };
  r.forEach((x) => { out[x.estado] = x.c; });
  return out;
}

/**
 * Resolver. Es explícito y de una sola vez: un comprobante ya resuelto no se vuelve a tocar, para
 * que reintentar no pueda generar el pago dos veces.
 */
function resolver(id, { estado, por = '', motivo = '', movimiento_id = null }) {
  if (!ESTADOS.includes(estado) || estado === 'pendiente') return { ok: false, error: 'estado inválido' };
  const c = get(id);
  if (!c) return { ok: false, error: 'no existe ese comprobante' };
  if (c.estado !== 'pendiente') return { ok: false, error: `ya estaba ${c.estado} desde ${c.resuelto_at || '?'}` };
  db.prepare('UPDATE comprobantes SET estado=?, resuelto_at=?, resuelto_por=?, motivo=?, movimiento_id=? WHERE id=? AND estado=\'pendiente\'')
    .run(estado, nowISO(), K(por), K(motivo).slice(0, 300), movimiento_id, String(id));
  return { ok: true, comprobante: get(id) };
}

/**
 * Deja anotado si el aviso al grupo salió o no.
 *
 * Se guarda SIEMPRE, salió bien o mal: un aviso que no salió es una cosa que hay que hacer, y si
 * no queda escrita no la hace nadie. El error va con el texto crudo de Telegram ("chat not found",
 * "bot was kicked") porque es lo único que distingue un id viejo de un bot que no es miembro.
 */
function marcarAviso(id, { ok, error }) {
  db.prepare('UPDATE comprobantes SET aviso_ok=?, aviso_error=?, aviso_at=? WHERE id=?')
    .run(ok ? 1 : 0, ok ? null : String(error || 'no se pudo avisar').slice(0, 300),
      new Date().toISOString(), String(id));
  return get(id);
}

/** El aviso al grupo DEL CLIENTE, que se sigue aparte del de cobranzas. */
function marcarAvisoCliente(id, { ok, error }) {
  db.prepare('UPDATE comprobantes SET aviso_cli_ok=?, aviso_cli_error=?, aviso_cli_at=? WHERE id=?')
    .run(ok ? 1 : 0, ok ? null : String(error || 'no se pudo avisar').slice(0, 300),
      new Date().toISOString(), String(id));
  return get(id);
}

module.exports = { marcarAviso, marcarAvisoCliente, crear, get, list, cuentas, resolver, MAX_BYTES, ESTADOS };
