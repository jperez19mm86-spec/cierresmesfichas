/* ══════ LOS TESTS DE LA PANTALLA ══════

   `test/caja.js` cubre el servidor. Esto cubre lo que la pantalla PIENSA: los números que lee, los
   logins que limpia, las fechas que compara y el menú que arma. Todo eso vive en
   `public/caja-logica.js`, afuera del dibujo, justamente para poder probarlo sin navegador.

   Cada verificación de acá abajo corresponde a un error que YA PASÓ, y que nadie vio hasta que
   apareció en pantalla: el monto multiplicado por diez, el cruce de IP que decía cero, el nivel
   que entraba como agente.

   Uso:  node test/caja-pantalla.js                                                               */

const L = require('../public/caja-logica');

const verificaciones = [];
function check(nombre, condicion, detalle) {
  verificaciones.push({ nombre, ok: !!condicion });
  console.log(`${condicion ? '✅' : '❌'} ${nombre}${detalle ? '  → ' + detalle : ''}`);
}

/* ── 1 · leer un monto ─────────────────────────────────────────────────────────────────────────
   🔴 EL QUE OFRECÍA CARGAR DIEZ VECES DE MÁS. */
check('7.028,6 es siete mil, no setenta mil', L.aNumero('7.028,6') === 7028.6, String(L.aNumero('7.028,6')));
check('con dos decimales tampoco se corre la coma', L.aNumero('1.234,56') === 1234.56, String(L.aNumero('1.234,56')));
check('el símbolo de la moneda no ensucia el número', L.aNumero('ARS 10.000') === 10000, String(L.aNumero('ARS 10.000')));
check('un entero con miles se lee entero', L.aNumero('10.000') === 10000, String(L.aNumero('10.000')));
check('sin separadores también', L.aNumero('250') === 250);
check('lo que no es un número da cero, no NaN', L.aNumero('hola') === 0 && L.aNumero(null) === 0 && L.aNumero('') === 0);
check('un negativo se conserva', L.aNumero('-1.500') === -1500, String(L.aNumero('-1.500')));

/* ── 2 · limpiar un login ───────────────────────────────────────────────────────────────────── */
check('el login no acepta espacios, ni antes ni al medio ni después',
  L.limpiarTextoLogin('  Juan  Perez ') === 'JuanPerez', L.limpiarTextoLogin('  Juan  Perez '));
check('ni símbolos de los que rompen la cuenta',
  L.limpiarTextoLogin('Jug#@&$_-+(ador') === 'Jugador', L.limpiarTextoLogin('Jug#@&$_-+(ador'));
check('un login que ya está bien no se toca', L.limpiarTextoLogin('Terminal01') === 'Terminal01');

check('«Juan Perez» y «juan.perez» son el mismo nombre', L.mismoNombre('Juan Perez', 'juan.perez'));
check('«Otro» y «juanperez» no lo son', !L.mismoNombre('Otro', 'juanperez'));
check('sin nombre no se contradice a nadie', L.mismoNombre('', 'loQueSea'));

/* ── 3 · cruces de IP ───────────────────────────────────────────────────────────────────────────
   🔴 EL QUE DECÍA «0 IPs COMPARTIDAS» CON DOS CUENTAS CONECTADAS. */
const hoy = { from: '2026-09-01', to: '2026-09-01' };
const dosQueEntraronHoy = [{ ip: '190.1.2.3', cuentas: [
  { login: 'JugadorViejo', hora: '2026-08-28 10:00:00', horas: ['2026-08-28 10:00:00', '2026-09-01 09:00:00'] },
  { login: 'JugadorNuevo', hora: '2026-09-01 09:05:00', horas: ['2026-09-01 09:05:00'] },
]}];
let cruces = L.crucesEnRango(dosQueEntraronHoy, hoy);
check('una cuenta vieja que entró hoy cuenta como cruce',
  cruces.length === 1 && cruces[0].cuentas.length === 2, `${cruces.length} cruces`);
check('y la hora que se muestra es la del período, no la vieja',
  cruces.length === 1 && cruces[0].cuentas[0].hora === '2026-09-01 09:00:00',
  cruces.length ? cruces[0].cuentas[0].hora : '');

check('si ninguna entró en el período, no hay cruce',
  L.crucesEnRango([{ ip: 'x', cuentas: [
    { login: 'A', hora: '2026-08-28 10:00:00', horas: ['2026-08-28 10:00:00'] },
    { login: 'B', hora: '2026-08-29 11:00:00', horas: ['2026-08-29 11:00:00'] },
  ]}], hoy).length === 0);

check('una sola cuenta en una IP no es un cruce',
  L.crucesEnRango([{ ip: 'x', cuentas: [
    { login: 'Solo', hora: '2026-09-01 09:00:00', horas: ['2026-09-01 09:00:00'] },
  ]}], hoy).length === 0);

check('el mes anterior muestra lo que pasó en el mes anterior',
  L.crucesEnRango(dosQueEntraronHoy, { from: '2026-08-01', to: '2026-08-31' }).length === 0
  && L.crucesEnRango([{ ip: 'x', cuentas: [
    { login: 'A', hora: '2026-08-28 10:00:00', horas: ['2026-08-28 10:00:00'] },
    { login: 'B', hora: '2026-08-29 11:00:00', horas: ['2026-08-29 11:00:00'] },
  ]}], { from: '2026-08-01', to: '2026-08-31' }).length === 1);

check('sin datos no se inventa nada', L.crucesEnRango(null, hoy).length === 0
  && L.crucesEnRango([], hoy).length === 0);

/* ── 4 · el nivel y su menú ─────────────────────────────────────────────────────────────────────
   🔴 EL QUE HACÍA QUE TODOS ENTRARAN COMO AGENTE. */
check('el grupo 3 es agente', L.nivelDeGrupo(3).rol === 'agente' && !L.nivelDeGrupo(3).subagente);
check('el grupo 4 es cajero', L.nivelDeGrupo(4).rol === 'cajero' && !L.nivelDeGrupo(4).subagente);
check('el grupo 8 es sub-cajero', L.nivelDeGrupo(8).rol === 'subcajero');
check('el grupo 6 navega como agente pero está marcado sub-agente',
  L.nivelDeGrupo(6).rol === 'agente' && L.nivelDeGrupo(6).subagente === true);
check('un grupo desconocido cae en el nivel más chico, no en el más grande',
  L.nivelDeGrupo(99).rol === 'cajero');

check('el agente ve sus cuatro secciones',
  L.seccionesDe('agente', false).join(',') === 'users,dashboard,balance,sub');
check('el cajero no ve la sección de sub-usuarios',
  !L.seccionesDe('cajero', false).includes('sub'));
check('el sub-agente no ve Movimientos ni Sub-usuarios, que el motor le niega',
  !L.seccionesDe('agente', true).includes('balance') && !L.seccionesDe('agente', true).includes('sub'),
  L.seccionesDe('agente', true).join(','));
check('y sí ve sus cajeros y el resumen',
  L.seccionesDe('agente', true).join(',') === 'users,dashboard');
check('nadie tiene Estadísticas ni Cruces en la barra — se llega desde otro lado',
  ['agente', 'cajero', 'subcajero'].every((r) => {
    const m = L.seccionesDe(r, false);
    return !m.includes('reports') && !m.includes('intersections');
  }));
check('cambiar el menú devuelto no cambia el original',
  (() => { const m = L.seccionesDe('agente', false); m.push('inventada');
    return L.seccionesDe('agente', false).length === 4; })());

/* ── 5 · sacar una sección que el motor niega ─────────────────────────────────────────────────── */
check('«No rights» en Movimientos saca Movimientos',
  L.seccionNegadaPor('movimientos', 'No rights') === 'balance');
check('«Sub users disabled» saca Sub-usuarios',
  L.seccionNegadaPor('subusuarios', 'Sub users disabled') === 'sub');
check('un corte de conexión NO saca nada',
  L.seccionNegadaPor('movimientos', 'El casino no contestó en 30 segundos.') === null);
check('un error de plata tampoco saca nada',
  L.seccionNegadaPor('movimientos', 'No alcanzan las fichas de la caja.') === null);
check('una ruta que no es una sección no saca nada',
  L.seccionNegadaPor('fichas', 'No rights') === null);

const fallaron = verificaciones.filter((v) => !v.ok);
console.log(`\n${verificaciones.length - fallaron.length}/${verificaciones.length} verificaciones pasaron`);
if (fallaron.length) {
  console.log('Fallaron:\n' + fallaron.map((v) => '  · ' + v.nombre).join('\n'));
  process.exit(1);
}
