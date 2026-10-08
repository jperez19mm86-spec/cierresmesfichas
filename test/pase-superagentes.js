/**
 * pase-superagentes.js — LOS PASOS DE UN MOVIMIENTO ENTRE PANELES, SOBRE TODO CRUZANDO PLATAFORMA.
 *
 * El caso que lo motivó: Oscar-SA (Europa) → Astrosbet.vip (Casino), dos SuperAgentes. La cadena
 * salía vacía y el pedido se rechazaba con «son la misma cuenta del casino».
 */
const assert = require('assert');
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'test-pase-' + Date.now() + '.sqlite');
const { pasosDeMovimiento } = require('../src/carga-cascada.service');

const SA = (id, login, sistema) => ({ id_usuario: id, usuario: login, nombre: login, nivel_usuario: 'SuperAgente', sistema, divisas: ['ARS'], escala: [], arbol_at: 'x' });
const hijo = (id, login, sa, sistema) => ({ id_usuario: id, usuario: login, nombre: login, nivel_usuario: 'Agente', sistema, divisas: ['ARS'], arbol_at: 'x',
  escala: [{ id: sa.id_usuario, login: sa.usuario, nivel: 'SuperAgente', divisas: ['ARS'] }] });
const ops = (p) => p.pasos.map((x) => `${x.op}(${x.login})`).join(' ');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };

console.log('\n🔀 pasos de un movimiento\n');
const oscar = SA('4174441', 'Oscar-SA', 'Europa'); const astros = SA('1890485', 'Astrosbet.vip', 'Casino');
let p = pasosDeMovimiento({ origen: oscar, destino: astros, divisa: 'ARS' });
ok(!p.bloqueo, 'SA→SA cruzando no se bloquea');
ok(ops(p) === 'out(Oscar-SA) in(Astrosbet.vip)', 'SA→SA cruzando: sale del origen y entra al destino');
ok(p.pasos[0].sistema === 'Europa' && p.pasos[1].sistema === 'Casino', 'cada paso lleva su plataforma');
ok(p.apoyoDestino === null, 'entre SuperAgentes el destino no tiene que poner saldo');

const a = hijo('10', 'AgE', oscar, 'Europa'); const b = hijo('20', 'AgC', astros, 'Casino');
p = pasosDeMovimiento({ origen: a, destino: b, divisa: 'ARS' });
ok(ops(p) === 'out(AgE) in(AgC)' && p.apoyoDestino.login === 'Astrosbet.vip', 'agente→agente cruzando: igual que antes, con los SA de apoyo');

const tri = SA('1890553', '7triple.net', 'Casino');
p = pasosDeMovimiento({ origen: tri, destino: astros, divisa: 'ARS' });
ok(ops(p) === 'out(7triple.net) in(Astrosbet.vip)' && !p.cruce, 'SA→SA misma plataforma: igual que antes');

p = pasosDeMovimiento({ origen: astros, destino: astros, divisa: 'ARS' });
ok(/misma cuenta/.test(p.bloqueo || ''), 'la misma cuenta de verdad se sigue rechazando');
console.log(`\n${n} chequeos OK\n`);
