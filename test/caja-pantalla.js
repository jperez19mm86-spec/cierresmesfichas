/* ══════ LOS TESTS DE LA PANTALLA ══════

   `test/caja.js` cubre el servidor. Esto cubre lo que la pantalla PIENSA: los números que lee, los
   logins que limpia, las fechas que compara y el menú que arma. Todo eso vive en
   `public/caja-logica.js`, afuera del dibujo, justamente para poder probarlo sin navegador.

   Cada verificación de acá abajo corresponde a un error que YA PASÓ, y que nadie vio hasta que
   apareció en pantalla: el monto multiplicado por diez, el cruce de IP que decía cero, el nivel
   que entraba como agente.

   Uso:  node test/caja-pantalla.js                                                               */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('../public/caja-logica');

const verificaciones = [];
function check(nombre, condicion, detalle) {
  verificaciones.push({ nombre, ok: !!condicion });
  console.log(`${condicion ? '✅' : '❌'} ${nombre}${detalle ? '  → ' + detalle : ''}`);
}

/* ── 0 · QUE LA PANTALLA COMPILE ───────────────────────────────────────────────────────────────
   🔴 ESTO FALTABA, Y COSTÓ CARO. El 2-sep-2026 un comentario con acentos graves adentro de una
   plantilla de texto rompió el script entero de `caja.html`: la página cargaba, los archivos
   cargaban, el servidor contestaba — y el botón de entrar no hacía nada, porque la función nunca
   llegaba a definirse. Nadie pudo entrar hasta que lo reportó el equipo.

   Las 71 verificaciones que ya había no lo vieron: probaban el servidor y la lógica suelta, pero
   nunca preguntaban si el archivo que ve el navegador es JavaScript válido. Ahora sí. */
function guionDe(archivo) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', archivo), 'utf8');
  const trozos = [];
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m = re.exec(html);
  while (m) { trozos.push(m[1]); m = re.exec(html); }
  return trozos;
}

const trozos = guionDe('caja.html');
check('caja.html trae su script adentro', trozos.length > 0, `${trozos.length} bloque(s)`);
trozos.forEach((codigo, i) => {
  let falla = null;
  try { new vm.Script(codigo, { filename: `caja.html#${i + 1}` }); }
  catch (e) { falla = e.message; }
  check(`el script ${i + 1} de caja.html compila`, !falla, falla || `${Math.round(codigo.length / 1024)} KB`);
});

for (const archivo of ['caja-conexion.js', 'caja-logica.js']) {
  let falla = null;
  try { new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'public', archivo), 'utf8'), { filename: archivo }); }
  catch (e) { falla = e.message; }
  check(`${archivo} compila`, !falla, falla || 'ok');
}

/* ── 0.bis · QUE NINGÚN DATO DE EJEMPLO SOBREVIVA AL LOGIN ─────────────────────────────────────
   🔴 LA MAQUETA TRAE LISTAS DE MUESTRA y cada pantalla las reemplaza recién cuando se la visita.
   Si alguien llega a una pantalla antes de pasar por la que trae esos datos, ve los inventados.

   Pasó el 2-sep-2026: al crear una caja, la pantalla de «a qué sub-agentes habilitarla» ofrecía
   `SubAgenteGXL` —un nombre de la maqueta, de nadie— y el casino contestaba «no tenés permiso».

   Esta verificación no mira una pantalla: mira que la LISTA DE LO QUE SE VACÍA al entrar cubra
   todas las colecciones de ejemplo que declara la maqueta. Si mañana alguien agrega una nueva y
   se olvida de vaciarla, esto se pone rojo antes de que se lo encuentre un operador. */
const htmlCaja = fs.readFileSync(path.join(__dirname, '..', 'public', 'caja.html'), 'utf8');
const conector = fs.readFileSync(path.join(__dirname, '..', 'public', 'caja-conexion.js'), 'utf8');

/* Qué cuenta como «dato de ejemplo»: una colección que arranca con CUENTAS INVENTADAS adentro.
   Se reconocen porque el propio texto trae un `login`. Las configuraciones (los meses, los
   íconos, los períodos) y los cachés vacíos no son esto y no hay que vaciarlos. */
const declaradas = [...htmlCaja.matchAll(/^(?:const|let) ([A-Z][A-Z_]{2,})\s*=\s*([[{][\s\S]{0,2600}?)\n(?:const|let|function|\/\*)/gm)]
  .filter((m) => /\blogin\s*:/.test(m[2]))
  .map((m) => m[1])
  /* `CUENTAS` queda afuera a propósito: no es una lista de otras personas, es «quién soy yo» en
     cada nivel, y el conector la PISA con los datos reales al entrar. Vaciarla rompería ese
     arranque, porque encima de ella se arma el saldo y el nivel. */
  .filter((n) => n !== 'CUENTAS');
const vaciadas = (conector.match(/function vaciarLosEjemplos\(\)[\s\S]*?\n  \}/) || [''])[0];
const sinVaciar = declaradas.filter((n) => !vaciadas.includes(`'${n}'`));

check('el conector tiene la rutina que tira los datos de ejemplo',
  vaciadas.length > 0);
check('y se llama apenas alguien entra de verdad',
  /window\.__caja_sesion = r\.yo;[\s\S]{0,80}vaciarLosEjemplos\(\)/.test(conector));
check('ninguna colección de ejemplo queda sin vaciar',
  sinVaciar.length === 0,
  sinVaciar.length ? `sin vaciar: ${sinVaciar.join(', ')}` : `${declaradas.length} cubiertas`);
check('el sub-agente inventado ya no puede llegar a una pantalla',
  htmlCaja.includes('SubAgenteGXL') && vaciadas.includes("'SUBAGENTES'"),
  'sigue en la maqueta, pero se tira al entrar');

/* ── 0.ter · LAS CUENTAS BORRADAS SE TIENEN QUE PODER ENCONTRAR ───────────────────────────────
   🔴 Reportado el 2-sep-2026: «al eliminar un cajero no aparece opción para restaurarlo y el saldo
   desaparece». No desaparecía —quedaba adentro de la cuenta oculta— pero el enlace a la lista de
   eliminados sólo se dibujaba ADENTRO de una caja. Un jugador borrado se encontraba; un cajero
   borrado, no: ni él ni sus fichas.

   Se verifica la regla, no el dibujo: que ese enlace no esté condicionado a NO estar mirando cajas.
   Es plata que nadie ve, y la única pantalla que la muestra no puede depender de dónde estés. */
check('el enlace a eliminados no se esconde cuando mirás las cajas',
  !/\$\{!salas \? enlaceBorrados\(/.test(htmlCaja) && /enlaceBorrados\(salas \?/.test(htmlCaja));
check('y la lista dice si son cajeros o jugadores',
  /Cajeros eliminados/.test(htmlCaja) && /Jugadores eliminados/.test(htmlCaja));
check('el conector le pasa ese dato al dibujar',
  /enlaceOriginal\.call\(window, cajaId, sonCajas\)/.test(conector));

/* 🔴 Reportado el 2-sep-2026 con SubASoph: la ficha decía «No ve ninguna caja» —un aviso fuerte,
   «entra al panel y no encuentra nada»— y esa cuenta las veía TODAS. Los permisos nunca se leían:
   quedaban en blanco y de ahí se concluía que no veía nada. Ahora el aviso está atado a haberlos
   leído de verdad, y el conector los pide al abrir la ficha. */
check('el aviso de «no ve ninguna caja» exige haber leído los permisos',
  /const sabemos = s\.permisosLeidos === true;/.test(htmlCaja)
  && /\$\{sabemos && !ve \?/.test(htmlCaja));
check('y el conector los pide al abrir la ficha, no por cada fila de la lista',
  /window\.abrirSubAgente = function/.test(conector)
  && /permisos-subagente/.test(conector)
  && !/SUBAGENTES\.map[\s\S]{0,200}permisos-subagente/.test(conector));
check('al cambiar un permiso se tira lo guardado',
  /olvidarPermisos\(subId\);/.test(conector));

/* 🔴 Reportado el 2-sep-2026 sobre el cajero GaCajersala: «Telegram funciona, pero WhatsApp no
   permite configurarlo». En un contacto NUEVO el canal elegido se guardaba en `CONTACTOS.__nuevo`
   y el formulario lo ignoraba al redibujarse, volviendo siempre a telegram: la pestaña de WhatsApp
   rebotaba. En uno ya existente andaba, porque ahí el canal se escribe en la lista. */
check('el formulario de un contacto nuevo respeta el canal elegido',
  /CONTACTOS\.__nuevo \|\| \{ type:'telegram'/.test(htmlCaja));
check('y lo olvida al salir, para que el próximo no herede el anterior',
  /function olvidarNuevo\(\)/.test(htmlCaja)
  && /olvidarNuevo\(\); volverContactos/.test(htmlCaja)
  && /olvidarNuevo\(\);/.test(conector));

/* 🔴 El link lo arma el casino pegando el valor tal cual: guardando «+549…» sale
   `https://wa.me/+549…`, y wa.me no acepta el «+» — el jugador toca y no le abre. */
check('un número de WhatsApp se guarda sin «+», que es lo que wa.me necesita',
  /return v\.replace\(\/\[\^\\d\]\/g, ''\);/.test(htmlCaja)
  && !/const mas = v\.trim\(\)\.startsWith\('\+'\)/.test(htmlCaja));

check('la cuenta propia no se arma encima del ejemplo de la maqueta',
  !/CUENTAS\[ROL\] = Object\.assign\(\{\}, CUENTAS\[ROL\]/.test(conector)
  && /CUENTAS\[ROL\] = \{/.test(conector),
  'todo campo que el servidor no manda quedaba con el valor inventado');

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

/* ── 3.bis · movimientos de cuentas eliminadas ──────────────────────────────────────────────────
   🔴 EL QUE MOSTRABA UNA CAJA BORRADA COMO SI SIGUIERA TRABAJANDO. Los datos son los reales del
   4-sep-2026: `CajTodo145348` y `CajReloj144848` estaban eliminadas y sus movimientos se leían
   igual que los de una caja viva. */
const movsReales = [
  { uid: '7357557', user: 'GanamosxLatamCaja', operation: 'out', cash: 2 },
  { uid: '7378791', user: 'CajTodo145348',     operation: 'in',  cash: 3 },
  { uid: '7378791', user: 'CajTodo145348',     operation: 'out', cash: 3 },
  { uid: '7378774', user: 'CajReloj144848',    operation: 'in',  cash: 2 },
];
const borradasDelAgente = [
  { id: '7378791', login: 'CajTodo145348',  sala: '7357552' },
  { id: '7378774', login: 'CajReloj144848', sala: '7357552' },
  { id: '9999999', login: 'DeOtraCaja',     sala: '7357836' },
];
let ya = L.eliminadasDeLaLista(movsReales, borradasDelAgente, '7357552');
check('una caja eliminada se reconoce en sus movimientos viejos',
  ya.has('7378791') && ya.has('7378774'), [...ya].join(','));
check('y la que sigue viva no se marca', !ya.has('7357557'));
check('cada cuenta cuenta una sola vez, aunque tenga varios movimientos',
  ya.size === 2, String(ya.size));

/* Una eliminada de OTRA caja no tiene por qué aparecer acá: si el nodo no filtrara, un login
   borrado en otro lado marcaría filas que no le corresponden. */
check('las eliminadas de otro nodo no se cuelan',
  !L.eliminadasDeLaLista([{ uid: '9999999', user: 'DeOtraCaja' }], borradasDelAgente, '7357552').size);

check('sin lista de eliminadas no se marca nada, no se adivina',
  L.eliminadasDeLaLista(movsReales, [], '7357552').size === 0
  && L.eliminadasDeLaLista(movsReales, null, '7357552').size === 0);
check('sin movimientos tampoco explota',
  L.eliminadasDeLaLista(null, borradasDelAgente, '7357552').size === 0);

/* El id llega como texto del motor y como número de algún lado: los dos tienen que cruzar. */
check('el id cruza aunque uno venga número y el otro texto',
  L.eliminadasDeLaLista([{ uid: 7378791, user: 'CajTodo145348' }],
    [{ id: 7378791, login: 'CajTodo145348', sala: 7357552 }], 7357552).size === 1);

/* 🔴 CON VOLUMEN. Medido: 20.000 movimientos y 3.000 eliminadas cruzan en 3,5 ms — y el motor
   corta la lista en 1.000 filas, así que ese caso ni siquiera puede darse. Lo que NO escala es
   nombrarlas: ahí salían 600 logins distintos. Por eso la pantalla no los nombra. */
const muchasBorr = Array.from({ length: 3000 }, (_, i) => ({ id: String(9e6 + i), sala: 'N' }));
const muchosMovs = Array.from({ length: 20000 }, (_, i) => ({ uid: i % 5 ? 'viva' + (i % 40) : String(9e6 + (i % 3000)) }));
const arranque = Date.now();
const gordo = L.eliminadasDeLaLista(muchosMovs, muchasBorr, 'N');
const tardo = Date.now() - arranque;
check('20.000 movimientos contra 3.000 eliminadas cruzan en menos de 50 ms',
  tardo < 50, tardo + ' ms');
check('y el resultado es un Set de ids, no una lista de nombres para armar',
  gordo instanceof Set && gordo.size === 600, String(gordo.size));
check('la pantalla no lista los logins en el aviso',
  !/yaNo\.logins/.test(htmlCaja));

check('la pantalla sólo AFIRMA cuando la lista ya se trajo',
  /window\.__borradosListos = function/.test(conector)
  && /cache\.has\(`borradas:\$\{nodo\}`\)/.test(conector));
check('y no dispara una consulta extra para saberlo',
  !/__borradosListos[\s\S]{0,300}API\.pedir/.test(conector));
check('con la lista traída y ninguna eliminada, no se muestra ningún aviso',
  /if \(sabemosBorr && !yaNo\.size\) return '';/.test(htmlCaja));

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

/* 🔴 NINGUNO DE LOS DOS NIVELES DE ABAJO TIENE RESUMEN, por dos motivos distintos:
   · al sub-agente el casino se lo contesta TODO EN CERO;
   · al sub-cajero se lo calcula, pero con el total de LA CAJA y no con lo que él ve — su lista
     mostraba 5 jugadores y el Resumen decía 8.
   Medidos los dos el 2-sep-2026. Una pantalla que muestra un número que no coincide con la de al
   lado confunde más de lo que informa. */
check('el sub-cajero SÍ tiene Resumen: ve todo lo de su caja',
  L.seccionesDe('subcajero', false).join(',') === 'users,dashboard,balance',
  L.seccionesDe('subcajero', false).join(','));
check('el sub-agente no, porque el casino se lo contesta en cero',
  L.seccionesDe('agente', true).join(',') === 'users',
  L.seccionesDe('agente', true).join(','));
check('y el total de cuentas ya no se llama «jugadores», porque cuenta las eliminadas',
  /Cuentas en total/.test(htmlCaja) && !/Jugadores en total/.test(htmlCaja)
  && /eliminadas[\s\S]{0,40}también cuentan/.test(htmlCaja));

/* El permiso «sin estadísticas» sigue importando: el motor no lo hace cumplir, así que si el dueño
   se lo apagó, esta pantalla no le puede dejar ninguna puerta. */
check('tampoco le queda una puerta a Estadísticas',
  L.puedeVerNumeros('subcajero', { disable_statistic: true }) === false
  && L.puedeVerNumeros('subcajero', {}) === true);
check('a los demás niveles el permiso no les aplica',
  L.puedeVerNumeros('agente', { disable_statistic: true }) === true
  && L.puedeVerNumeros('cajero', { disable_statistic: true }) === true);
check('el sub-agente no ve Movimientos ni Sub-usuarios, que el motor le niega',
  !L.seccionesDe('agente', true).includes('balance') && !L.seccionesDe('agente', true).includes('sub'),
  L.seccionesDe('agente', true).join(','));
/* 🔴 Tampoco el Resumen: el casino se lo contesta en cero y sostenerlo costaba una consulta más
   por visita. Si el casino no lo da, la pantalla no va — decisión del dueño, 2-sep-2026. */
check('ni el Resumen, que el casino no le calcula',
  L.seccionesDe('agente', true).join(',') === 'users');
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
