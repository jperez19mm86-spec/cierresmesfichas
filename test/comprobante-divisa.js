/**
 * comprobante-divisa.js — la divisa de un aviso de pago no puede llevar un programa (29-oct-2026).
 * El cliente la escribía libre, se guardaba tal cual y el panel la pegaba adentro de un onclick:
 * con sólo un código se dejaba JavaScript que corría con la sesión de quien aprueba.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comp-divisa-')), 'p.sqlite');
const comprobantes = require('../src/comprobantes-store');

const v = []; const check = (n, c, d) => { v.push(!!c); console.log((c ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : '')); };
const crear = (via, divisa) => comprobantes.crear({ codigo: 'X1', clienteNombre: 'X', via, monto: '100', divisa }).comprobante;

const ATAQUE = "ARS'});[][(![]+[])[+[]]]//";
check('un ataque en la divisa se guarda como ARS', crear('ars', ATAQUE).divisa === 'ARS', crear('ars', ATAQUE).divisa);
check('por USDT siempre USDT aunque mande otra cosa', crear('usdt', ATAQUE).divisa === 'USDT');
check('pesos por CVU quedan ARS', crear('ars', 'ARS').divisa === 'ARS');
check('USDT en efectivo (cargado a mano) sigue siendo USDT', crear('ars', 'usdt').divisa === 'USDT');
check('una moneda inventada vuelve a ARS', crear('ars', 'PYG').divisa === 'ARS');
check('sin divisa, ARS', crear('ars', undefined).divisa === 'ARS');

// El panel: ningún dato del comprobante se pega adentro de un onclick con la divisa.
const html = fs.readFileSync(path.join(__dirname, '../public/os.html'), 'utf8');
check('el botón «TC del mes» ya no arma la divisa dentro del onclick', !/divisa:\\''\s*\+\s*esc\(c\.divisa/.test(html));
const linea = html.split('\n').find((l) => l.includes('Aprobar con el TC del mes</button>'));
check('el botón lleva la divisa en data-div y la reduce a ARS/USDT', !!linea && /this\.dataset\.div===\\'USDT\\'/.test(linea));
const btn = html.split('\n').filter((l) => l.includes('data-div=')).join('\n');
check('data-div va escapado', /data-div="' \+ esc\(c\.divisa/.test(btn));

const mal = v.filter((x) => !x).length;
console.log(`\n${v.length - mal}/${v.length}`);
process.exit(mal ? 1 : 0);
