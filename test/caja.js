/* ══════ LOS TESTS DE MI CAJA ══════

   Se levanta Mi Caja de verdad, contra un casino de mentira (`caja-motor-falso.js`), y se la
   ejercita por HTTP como lo haría el panel. Nada de esto toca el casino real: ninguna corrida
   mueve una ficha de nadie.

   El orden no es caprichoso: primero lo que mueve plata. Cada verificación de acá abajo
   corresponde a un error que YA PASÓ —está en la auditoría del 1-sep-2026— y que nadie habría
   notado hasta que el operador lo viera en pantalla.

   Uso:  node test/caja.js                                                                        */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { crearMotorFalso } = require('./caja-motor-falso');

const RAIZ = path.join(__dirname, '..');
const PUERTO_CAJA = 4700;
const PUERTO_MOTOR = 4701;
const BASE = `http://localhost:${PUERTO_CAJA}`;
const MOTOR = `http://localhost:${PUERTO_MOTOR}`;
const BASEDATOS = path.join(RAIZ, 'data', 'test-caja.sqlite');

for (const f of [BASEDATOS, BASEDATOS + '-wal', BASEDATOS + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch (e) { /* no estaba */ }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

let galleta = '';
const opciones = () => ({ validateStatus: () => true, headers: galleta ? { Cookie: galleta } : {} });
const pedir = (p) => axios.get(BASE + p, opciones());
const enviar = (p, cuerpo) => axios.post(BASE + p, cuerpo, opciones());
const pedidosDelMotor = async () => (await axios.get(MOTOR + '/__pedidos')).data;
const estadoDelMotor = async () => (await axios.get(MOTOR + '/__estado')).data;
const reiniciarMotor = () => axios.post(MOTOR + '/__reiniciar', {});
const saldoDe = async (id) => (await estadoDelMotor()).find((c) => c.id === String(id)).saldo;

const verificaciones = [];
function check(nombre, condicion, detalle) {
  verificaciones.push({ nombre, ok: !!condicion });
  console.log(`${condicion ? '✅' : '❌'} ${nombre}${detalle ? '  → ' + detalle : ''}`);
}

const gestoNuevo = () => 'g' + Math.random().toString(36).slice(2, 10);

const cargar = (cuerpo) => enviar('/api/caja/fichas', {
  padre: '200', operacion: 'in', todo: false, ...cuerpo,
});

async function esperarQueLevante(motorFalso) {
  for (let i = 0; i < 60; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await axios.get(BASE + '/api/caja/yo', { validateStatus: () => true, timeout: 1000 });
      if (r.status) return true;
    } catch (e) { /* todavía no */ }
    // eslint-disable-next-line no-await-in-loop
    await dormir(250);
  }
  throw new Error('Mi Caja no levantó\n' + motorFalso.registro);
}

async function main() {
  const motor = crearMotorFalso();
  await motor.escuchar(PUERTO_MOTOR);

  const entorno = {
    ...process.env,
    PORT: String(PUERTO_CAJA),
    SOLO_CAJA: '1',
    CASINO_URL: MOTOR,
    DB_PATH: BASEDATOS,
    SESSION_SECRET: 'test',
    CRED_KEY: 'testkey',
    DIARIO_CLAVE: 'clave-de-test',
    /* 🔴 CON CREDENCIAL RAÍZ, COMO EN PRODUCCIÓN. Sin ella, leer los permisos de un sub-cajero
       falla —una cuenta no puede leer su propia ficha— y el test aprobaba un camino que en el
       servidor de verdad no es el que corre. */
    CASINO_ROOT_TOKEN: 'token-de-raiz-para-pruebas',
    CASINO_ROOT_USER: '',
    CASINO_ROOT_PASSWORD: '',
  };
  const srv = spawn('node', ['src/index.js'], { cwd: RAIZ, env: entorno, stdio: ['ignore', 'pipe', 'pipe'] });
  let registro = '';
  srv.stdout.on('data', (d) => { registro += d; });
  srv.stderr.on('data', (d) => { registro += d; });

  try {
    await esperarQueLevante({ registro });

    /* ── 1 · entrar ─────────────────────────────────────────────────────────────────────── */
    let r = await enviar('/api/caja/login', { usuario: 'AgenteDePrueba', clave: 'clave-de-prueba' });
    galleta = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    check('entra un agente', r.data && r.data.ok && galleta, r.data && r.data.error);
    check('el nivel sale del grupo que da el motor, no de un selector',
      r.data.ok && r.data.yo.rol === 'agente', r.data.ok ? r.data.yo.rol : '');

    r = await enviar('/api/caja/login', { usuario: 'AgenteDePrueba', clave: 'la-que-no-es' });
    check('con la clave equivocada no entra', r.status === 401 && !r.data.ok);

    /* Se recupera la sesión buena para lo que sigue. */
    r = await enviar('/api/caja/login', { usuario: 'AgenteDePrueba', clave: 'clave-de-prueba' });
    galleta = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

    r = await pedir('/api/caja/yo');
    check('el saldo de la cabecera lo dice el motor, no la maqueta',
      r.data.ok && r.data.yo.balance === 50000, String(r.data.ok && r.data.yo.balance));

    /* ── 2 · lo que mueve plata ─────────────────────────────────────────────────────────── */
    await reiniciarMotor();
    const antesJugador = await saldoDe('301');
    r = await cargar({ cuenta: '301', login: 'JugadorUno', monto: 100, gesto: gestoNuevo() });
    check('una carga mueve exactamente lo pedido',
      r.data.ok && r.data.movido === 100, r.data.ok ? `movió ${r.data.movido}` : r.data.error);
    check('el saldo que informa es el que quedó en el motor',
      r.data.ok && r.data.despues === antesJugador + 100 && (await saldoDe('301')) === antesJugador + 100);
    check('la caja pagadora quedó con menos', (await saldoDe('200')) === 8000 - 100);

    /* 🔴 EL ERROR QUE COBRÓ 10.000 DOS VECES. El mismo gesto repetido —que es lo que manda el
       panel cuando se vence el reloj del navegador— no puede volver a mover una ficha. */
    await reiniciarMotor();
    const gestoRepetido = gestoNuevo();
    const cuerpoIgual = { cuenta: '301', login: 'JugadorUno', monto: 50, gesto: gestoRepetido };
    const saldoPrevio = await saldoDe('301');
    const primera = await cargar(cuerpoIgual);
    const segunda = await cargar(cuerpoIgual);
    check('el mismo gesto dos veces mueve UNA sola vez',
      (await saldoDe('301')) === saldoPrevio + 50,
      `${saldoPrevio} → ${await saldoDe('301')}`);
    check('la segunda vez el motor no recibe otra orden de saldo',
      (await pedidosDelMotor()).filter((p) => p.area === 'balance' && p.cuerpo.send === 'true').length === 1);
    check('la segunda vez se avisa que ya se había hecho, con el resultado adentro',
      primera.data.ok && !segunda.data.ok && segunda.data.repetida
        && segunda.data.resultado && segunda.data.resultado.movido === 50);

    /* Dos pedidos DISTINTOS sobre la misma cuenta a la vez: no es doble clic, tienen que entrar
       los dos, uno después del otro. */
    await reiniciarMotor();
    const base301 = await saldoDe('301');
    const [a, b] = await Promise.all([
      cargar({ cuenta: '301', login: 'JugadorUno', monto: 10, gesto: gestoNuevo() }),
      cargar({ cuenta: '301', login: 'JugadorUno', monto: 20, gesto: gestoNuevo() }),
    ]);
    check('dos cargas distintas a la vez entran las dos, sin pisarse',
      a.data.ok && b.data.ok && (await saldoDe('301')) === base301 + 30,
      `${base301} → ${await saldoDe('301')}`);

    /* El rechazo silencioso: el motor acepta la orden y no mueve nada. */
    await reiniciarMotor();
    r = await cargar({ cuenta: '301', login: 'JugadorUno', monto: 999999, gesto: gestoNuevo() });
    check('si el motor no movió nada, se dice — no se muestra un ✓ falso',
      !r.data.ok && r.data.sinEfecto === true, r.data.error);

    /* 🔴 «RETIRAR TODO» DE UNA CAJA TIENE QUE FUNCIONAR. El casino ignora `all` cuando el destino
       es una caja —el motor de mentira lo imita—, así que el servidor reintenta con el monto
       exacto, que ya leyó. Para el operador es un botón que anda; el rodeo no se ve. */
    await reiniciarMotor();
    const cajaAntes = await saldoDe('200');
    const pagadorAntes = await saldoDe('100');
    r = await enviar('/api/caja/fichas', {
      cuenta: '200', padre: '100', login: 'CajaDePrueba', operacion: 'out', todo: true, gesto: gestoNuevo(),
    });
    check('«retirar todo» vacía una caja, aunque el casino ignore «todo»',
      r.data.ok && (await saldoDe('200')) === 0 && r.data.movido === -cajaAntes,
      r.data.ok ? `${cajaAntes} → ${await saldoDe('200')}` : r.data.error);
    check('y las fichas aparecen en quien las pagó, ni una de menos',
      (await saldoDe('100')) === pagadorAntes + cajaAntes,
      `${pagadorAntes} → ${await saldoDe('100')} (esperado ${pagadorAntes + cajaAntes})`);
    /* Una caja vacía no tiene nada que retirar: ahí sí corresponde avisar, y sin culpar a nadie. */
    const cajaVacia = await enviar('/api/caja/fichas', {
      cuenta: '200', padre: '100', login: 'CajaDePrueba', operacion: 'out', todo: true,
      gesto: gestoNuevo(),
    });
    check('si no hay nada que retirar, se dice sin inventar un culpable',
      !cajaVacia.data.ok && cajaVacia.data.sinEfecto === true
        && !/el jugador tenga ese saldo/.test(cajaVacia.data.error || ''),
      (cajaVacia.data.error || '').slice(0, 62));

    /* 🔴 SE DEVUELVEN LAS FICHAS. Vaciar la caja acá dejaba sin fondos a las pruebas de más
       abajo, y fallaban por una razón que no tenía nada que ver con lo que verifican. Un test que
       le rompe el piso al siguiente miente dos veces: aprueba lo suyo y ensucia lo ajeno. */
    await enviar('/api/caja/fichas', {
      cuenta: '200', padre: '100', login: 'CajaDePrueba', operacion: 'in', monto: cajaAntes,
      todo: false, gesto: gestoNuevo(),
    });
    check('y la caja vuelve a quedar como estaba, para lo que sigue',
      (await saldoDe('200')) === cajaAntes, `${await saldoDe('200')} de ${cajaAntes}`);


    /* ── 3 · el filtro que el motor hereda ──────────────────────────────────────────────── */
    await reiniciarMotor();
    await pedir('/api/caja/cuentas?nodo=200');
    await cargar({ cuenta: '302', login: 'JugadorDos', monto: 5, gesto: gestoNuevo() });
    await pedir('/api/caja/eliminadas?nodo=200');
    const consultas = (await pedidosDelMotor()).filter((p) => p.area === 'users');
    const sinFiltro = consultas.filter((p) => !p.cuerpo.deleted_users || !p.cuerpo.inactive_users);
    check('toda consulta de cuentas manda sus filtros, aunque parezcan de más',
      consultas.length > 0 && sinFiltro.length === 0,
      `${consultas.length} consultas · ${sinFiltro.length} sin filtro`);
    check('y todas mandan el rango de fechas',
      consultas.every((p) => p.cuerpo.from && p.cuerpo.to));

    /* Después de mirar las eliminadas, cargar tiene que seguir funcionando: ése era el error. */
    await reiniciarMotor();
    const antesDelFiltro = await saldoDe('302');
    r = await cargar({ cuenta: '302', login: 'JugadorDos', monto: 7, gesto: gestoNuevo() });
    check('cargar sigue andando después de abrir «eliminados»',
      r.data.ok && (await saldoDe('302')) === antesDelFiltro + 7, r.data.error);

    /* ── 4 · el alta ────────────────────────────────────────────────────────────────────── */
    await reiniciarMotor();
    r = await enviar('/api/caja/crear', { login: 'JugadorNuevo', clave: 'Prueba2026x', tipo: 'jugador', padre: '200' });
    check('crear una cuenta recién nacida no dice «ese nombre ya está usado»',
      r.data.ok, r.data.ok ? `id ${r.data.cuenta.id}` : r.data.error);
    const creada = (await estadoDelMotor()).find((c) => c.login === 'JugadorNuevo');
    check('y la cuenta existe de verdad en el motor', !!creada, creada && `id ${creada.id}`);

    /* ── 5 · quién puede qué ────────────────────────────────────────────────────────────── */
    r = await pedir('/api/caja/acciones');
    check('el motor dice qué autoriza', r.data.ok && r.data.acciones.length > 0,
      r.data.ok && r.data.acciones.map((x) => x.name).join(','));

    r = await enviar('/api/caja/login', { usuario: 'CajaDePrueba', clave: 'clave-de-prueba' });
    const galletaCaja = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    check('un cajero entra como cajero, no como agente',
      r.data.ok && r.data.yo.rol === 'cajero', r.data.ok ? r.data.yo.rol : r.data.error);

    /* ── 5.bis · UN SUB-CAJERO NO HEREDA DATOS DE OTRO ──────────────────────────────────────
       🔴 Reportado el 2-sep-2026 con SubbCajacc: al entrar veía «2 eliminados · saldo ARS 100» de
       una caja que no era la suya. Eran los datos de EJEMPLO de la maqueta, que traía escrita a
       mano la caja 7357557 —de un cliente real— y dos permisos siempre encendidos. El panel los
       heredaba porque el servidor no mandaba esos campos y se armaba encima del ejemplo. */
    const galletaAgente = galleta;
    r = await enviar('/api/caja/login', { usuario: 'SubCajaDePrueba', clave: 'clave-de-prueba' });
    const galletaSub = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    check('entra un sub-cajero', r.data.ok && r.data.yo.rol === 'subcajero',
      r.data.ok ? r.data.yo.rol : r.data.error);
    check('sus permisos salen del motor, no de un valor escrito a mano',
      r.data.ok && r.data.yo.hide_hall_balance === true && r.data.yo.disable_statistic === false,
      r.data.ok ? `esconder saldo=${r.data.yo.hide_hall_balance} sin estadísticas=${r.data.yo.disable_statistic}` : '');
    check('y no se le inventa una caja: si no se sabe, se dice que no se sabe',
      r.data.ok && r.data.yo.caja === null, r.data.ok ? String(r.data.yo.caja) : '');

    galleta = galletaSub;
    r = await pedir('/api/caja/eliminadas');
    check('sus cuentas eliminadas son las suyas, no las de otra caja',
      r.data.ok && (r.data.eliminadas || []).length === 0,
      r.data.ok ? `${(r.data.eliminadas || []).length}` : r.data.error);
    /* 🔴 EL RESUMEN DE UN SUB-AGENTE. El casino le contesta TODO EN CERO — medido el 2-sep-2026:
       el agente ve 13 jugadores y el sub-agente 0, en su propio nodo y en la caja que sí tiene
       habilitada. Cero se lee como «no hay», que es una mentira que asusta. Lo que el motor sí le
       da es la lista de sus cajas con cuántos jugadores tiene cada una, y de ahí sale el número
       de verdad. Lo que no se puede derivar se marca, para decirlo en vez de mostrar un cero. */
    galleta = galletaAgente;

    /* ── 5.ter · EL SUB-AGENTE NO TIENE RESUMEN ─────────────────────────────────────────────
       🔴 El casino le contesta ese panel TODO EN CERO —medido el 2-sep-2026— y un cero se lee como
       «no hay». Se llegó a calcularlo sumando sus cajas y se dio de baja: costaba una consulta más
       por visita para sostener algo que el casino no sostiene. La pantalla no existe a ese nivel.
       Se verifica que el resumen NO haga consultas de más, que es lo que motivó sacarlo. */
    r = await enviar('/api/caja/login', { usuario: 'SubAgenteDePrueba', clave: 'clave-de-prueba' });
    const galletaSubAg = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    check('entra un sub-agente', r.data.ok && r.data.yo.group === '6',
      r.data.ok ? `grupo ${r.data.yo.group}` : r.data.error);

    galleta = galletaSubAg;
    await reiniciarMotor();
    r = await pedir('/api/caja/resumen');
    const pedidosResumen = await pedidosDelMotor();
    check('el resumen pide UNA sola cosa al casino, no dos',
      pedidosResumen.filter((x) => x.area === 'dashboardinfo').length === 1
      && pedidosResumen.filter((x) => x.area === 'users').length === 0,
      `dashboardinfo=${pedidosResumen.filter((x) => x.area === 'dashboardinfo').length} · users=${pedidosResumen.filter((x) => x.area === 'users').length}`);
    galleta = galletaAgente;

    /* ── 6 · el diario ───────────────────────────────────────────────────────────────────── */
    const diario = (clave) => axios.get(`${BASE}/api/caja/_diario${clave ? `?clave=${clave}` : ''}`,
      { validateStatus: () => true });
    r = await diario('');
    check('el diario sin clave no existe — contesta 404, no «falta la clave»', r.status === 404);
    r = await diario('la-que-no-es');
    check('con la clave equivocada tampoco', r.status === 404);
    r = await diario('clave-de-test');
    check('con la clave buena, ahí está', r.status === 200 && r.data.ok && r.data.total > 0,
      r.data.ok ? `${r.data.total} pedidos` : '');
    const mov = (r.data.filas || []).filter((f) => f.ruta === 'fichas');
    check('de un movimiento anota el monto y la cuenta, no sólo que pasó',
      mov.length > 0 && mov.some((f) => f.detalle && f.detalle.cuenta && f.detalle.monto != null),
      mov.length ? JSON.stringify(mov[mov.length - 1].detalle) : 'ninguno');
    check('de un movimiento anota lo que se movió DE VERDAD, no sólo que salió bien',
      mov.some((f) => f.resultado && typeof f.resultado.movido === 'number'),
      JSON.stringify((mov.find((f) => f.resultado) || {}).resultado));
    check('anota el motivo cuando el motor rechaza',
      (r.data.filas || []).some((f) => f.error));
    check('y mide cuánto tardó cada pantalla',
      (r.data.resumen || []).length > 0 && r.data.resumen.every((x) => typeof x.medio === 'number'));
    /* El número de caso: el puente entre lo que vio la persona y lo que quedó anotado. */
    const conCaso = await axios.post(`${BASE}/api/caja/fichas`,
      { cuenta: '301', login: 'JugadorUno', padre: '200', operacion: 'in', monto: 999999,
        todo: false, gesto: gestoNuevo() },
      { validateStatus: () => true, headers: { Cookie: galleta } });
    const nCaso = conCaso.headers['x-caso'];
    check('cada respuesta trae su número de caso en la cabecera', !!nCaso, `E-${nCaso}`);
    r = await diario('clave-de-test');
    const suyo = (r.data.filas || []).filter((f) => String(f.n) === String(nCaso));
    check('ese número encuentra el caso exacto en el diario',
      suyo.length === 1 && suyo[0].ruta === 'fichas' && !!suyo[0].error,
      suyo.length ? `${suyo[0].ruta} · ${suyo[0].error.slice(0, 40)}` : 'no lo encontró');
    r = await axios.get(`${BASE}/api/caja/_diario?clave=clave-de-test&caso=${nCaso}`,
      { validateStatus: () => true });
    check('y se puede buscar por número, sin leer todo',
      r.data.ok && r.data.filas.length === 1 && String(r.data.filas[0].n) === String(nCaso));

    check('el diario no se anota a sí mismo',
      !(r.data.filas || []).some((f) => f.ruta.includes('_diario')));
    check('ninguna contraseña quedó anotada',
      !JSON.stringify(r.data).includes('clave-de-prueba'));

    /* ── 7 · sin sesión no se toca nada ─────────────────────────────────────────────────── */
    const sinGalleta = galleta; galleta = '';
    r = await cargar({ cuenta: '301', login: 'JugadorUno', monto: 1, gesto: gestoNuevo() });
    check('sin sesión no se mueve una ficha', r.status === 401 && !r.data.ok);
    galleta = sinGalleta;
    void galletaCaja;
  } finally {
    srv.kill();
    await motor.cerrar();
  }

  /* 🔴 EL ARREGLO QUE NO LLEGA. Reportado dos veces el mismo error (`SubAgenteGXL`) con un día de
   diferencia, ya corregido: el navegador traía `caja.html` fresco y `caja-conexion.js` de hasta
   una hora antes. La pantalla y su conector tienen que caducar juntos. */
{
  const idx = require('fs').readFileSync(__dirname + '/../src/index.js', 'utf8');
  check('el conector y la lógica caducan igual que la pantalla',
    /SIEMPRE_FRESCO = \/\(\\.html\?\|caja-\(conexion\|logica\)\\.js\)\$\/i/.test(idx));
  check('y lo demás sigue guardándose una hora',
    /SIEMPRE_FRESCO\.test\(ruta\) \? 'no-cache' : 'public, max-age=3600'/.test(idx));
}

const fallaron = verificaciones.filter((v) => !v.ok);
  console.log(`\n${verificaciones.length - fallaron.length}/${verificaciones.length} verificaciones pasaron`);
  if (fallaron.length) {
    console.log('Fallaron:\n' + fallaron.map((v) => '  · ' + v.nombre).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => { console.error('SE ROMPIÓ:', e && e.stack ? e.stack : e); process.exit(1); });
