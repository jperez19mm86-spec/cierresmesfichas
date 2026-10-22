/**
 * reglas-comunes.js — LAS REGLAS QUE USA TODO EL SISTEMA, EN UN SOLO LUGAR.
 *
 * «A qué mes entra un movimiento», los nombres de los meses, el formato de la plata y cómo se
 * escapa el HTML estaban copiados en varios archivos, cada copia con su variante. Una copia que se
 * corrige y otra que no es cómo el mismo pago termina en dos meses según la pantalla (22-oct-2026).
 * Esto prueba las reglas y además que nadie vuelva a escribir su propia copia.
 */
const fs = require('fs'); const path = require('path');
const Database = require('better-sqlite3');
const { mesDe, MES_SQL } = require('../src/lib/mes-de');
const { MESES, MESES_MAY, plata } = require('../src/lib/formato');
const { escTexto, esc, escTodo } = require('../src/lib/html');
const { mesCierre } = require('../src/lib/fechas');

let ok = 0, fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x ? '  → ' + x : '')); } };
console.log('\n📏 las reglas comunes viven en un solo lugar\n');

// ── 1. A qué mes entra ─────────────────────────────────────────────────────────────────────────
const casos = [
  [{ mes_cierre: '2026-08', fecha: '2026-09-03T10:00:00Z', createdAt: '2026-09-03T10:00:00Z' }, '2026-08'],
  [{ mes_cierre: '2026-08-31', fecha: '2026-09-03' }, '2026-08'],
  [{ mes_cierre: '', fecha: '2026-09-03', createdAt: '2026-10-01' }, '2026-09'],
  [{ mes_cierre: null, fecha: null, createdAt: '2026-10-01T00:00:00Z' }, '2026-10'],
  [{}, ''],
];
for (const [m, esperado] of casos) check(`mesDe ${JSON.stringify(m)} → «${esperado}»`, mesDe(m) === esperado, mesDe(m));
check('mesDe de nada no revienta', mesDe(null) === '' && mesDe(undefined) === '');
{
  // La misma regla en SQL (la que usa movimientos-store.list({mes})) tiene que dar lo mismo.
  const db = new Database(':memory:');
  db.exec('CREATE TABLE movimientos (id INTEGER PRIMARY KEY, mes_cierre TEXT, fecha TEXT, createdAt TEXT)');
  const ins = db.prepare('INSERT INTO movimientos (mes_cierre, fecha, createdAt) VALUES (?,?,?)');
  casos.slice(0, 4).forEach(([m]) => ins.run(m.mes_cierre || null, m.fecha || null, m.createdAt || null));
  const filas = db.prepare(`SELECT *, ${MES_SQL} AS mes FROM movimientos ORDER BY id`).all();
  const distintos = filas.filter((r) => r.mes !== mesDe(r));
  check('la regla en SQL da lo mismo que en JavaScript', !distintos.length, JSON.stringify(distintos));
}

// ── 2. Meses, plata y HTML ─────────────────────────────────────────────────────────────────────
check('doce meses, en minúscula', MESES.length === 12 && MESES[6] === 'julio' && MESES[11] === 'diciembre');
check('con mayúscula para la grilla', MESES_MAY[6] === 'Julio' && mesCierre('2026-07') === 'Julio_2026');
check('plata es-AR', plata(1234.5) === '1.234,50' && plata('') === '0,00' && plata(null, 0) === '0' && plata(0.125, 3) === '0,125',
  [plata(1234.5), plata(''), plata(null, 0), plata(0.125, 3)].join(' | '));
const t = `a & b < c > d " e ' f`;
check('escTexto: sólo & < > (Telegram)', escTexto(t) === `a &amp; b &lt; c &gt; d " e ' f`);
check('esc: más las comillas dobles (documentos)', esc(t) === `a &amp; b &lt; c &gt; d &quot; e ' f`);
check('escTodo: más la comilla simple', escTodo(t) === `a &amp; b &lt; c &gt; d &quot; e &#39; f`);
check('null y undefined dan vacío', esc(null) === '' && escTexto(undefined) === '' && escTodo(0) === '0');

// ── 3. Que nadie escriba su propia copia ───────────────────────────────────────────────────────
const SRC = path.join(__dirname, '..', 'src');
const archivos = [];
(function rec(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, f.name);
  if (f.isDirectory()) rec(p); else if (f.name.endsWith('.js') && !p.includes(path.join('src', 'lib'))) archivos.push(p);
} })(SRC);
const buscar = (re) => archivos.filter((p) => re.test(fs.readFileSync(p, 'utf8'))).map((p) => path.relative(SRC, p));
const lista = buscar(/['"]enero['"],\s*['"]febrero['"]|['"]Enero['"],\s*['"]Febrero['"]/i);
check('los nombres de los meses no están copiados fuera de lib/formato', !lista.length, lista.join(', '));
const escs = buscar(/(const|function)\s+(esc|escapeHtml)\s*(=\s*\(|\()[^)]*\)\s*(=>|\{)\s*(return\s+)?String\(/);
check('escapar HTML no está copiado fuera de lib/html', !escs.length, escs.join(', '));
// Una copia es «el mes de cierre, y si no, el de la fecha»; recortar el mes de cierre al guardarlo no lo es.
const meses = buscar(/mes_cierre\s*\?\s*String\([^)]*\)\.slice\(0, 7\)\s*:\s*String\(|String\(\s*\w+\.mes_cierre\s*\|\||\.mes_cierre\s*\|\|\s*String\(\s*\w+\.fecha/);
check('«a qué mes entra» no está copiado fuera de lib/mes-de', !meses.length, meses.join(', '));
const plataN = buscar(/const n = \(x, d = 2\) => Number\(x \|\| 0\)\.toLocaleString\('es-AR'/);
check('el formato de plata de los documentos sale de lib/formato', !plataN.length, plataN.join(', '));

console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
