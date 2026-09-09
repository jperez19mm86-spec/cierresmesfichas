/* Se envuelve en una función async: una verificación necesita esperar una promesa. */
(async () => {
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

/* 🔴 EL MOTOR TAMBIÉN ESCRIBE EN INGLÉS. Una apuesta deportiva devolvió «4,671.10»: con la regla
   argentina se leía 4,67 — casi mil veces menos, en la pantalla donde se decide cuánto cargar. */
check('«4,671.10» son cuatro mil, no cuatro con sesenta y siete',
  L.aNumero('4,671.10') === 4671.10, String(L.aNumero('4,671.10')));
check('y «7.028,6» sigue siendo siete mil', L.aNumero('7.028,6') === 7028.6);
check('con un solo separador manda la regla de acá',
  L.aNumero('1.234') === 1234 && L.aNumero('1,5') === 1.5,
  `${L.aNumero('1.234')} y ${L.aNumero('1,5')}`);
check('y el inglés con miles y sin decimales también',
  L.aNumero('1,200,000') === 1200000, String(L.aNumero('1,200,000')));

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

/* ── 6 · lo que se le dice a quien acaba de crear una cuenta ────────────────────────────────────
   🔴 DOS TEXTOS QUE CONFUNDÍAN, reportados el 4-sep-2026. */
check('el aviso de credenciales se adapta a si hay link o no',
  /const AVISO_CRED = \(hayLink\) =>/.test(conector)
  && !/Las dos cosas valen lo mismo que la contraseña/.test(conector),
  'sin link no puede decir «las dos cosas»');
check('y dice lo único que importa: que con eso se entra',
  /Con eso se entra a la cuenta/.test(conector)
  && /Cualquiera de las dos cosas abre la cuenta/.test(conector));
/* 🔴 EL AVISO DE «SIN LINK» ERA UNA FALTA, Y AHORA ES UNA PUERTA. Explicaba que se configura caja
   por caja y que tener dominios habilitados en el casino no alcanza: cierto, y nada que quien lo
   lee pueda hacer. Reescrito con el dueño el 9-sep-2026 con sus palabras. Que mientras tanto se
   entra con usuario y contraseña tampoco hace falta: están arriba, en el mismo recuadro. */
check('el aviso de «sin link» ofrece el link, no explica cómo se configura',
  /Se puede habilitar un <b>link<\/b>/.test(conector)
  && !/caja por caja: que el casino/.test(conector)
  && !/dominios habilitados no alcanza/.test(conector));
check('y dice a quién pedírselo',
  /Ped\u00edselo a soporte y te lo habilitan/.test(conector));

/* 🔴 UNA CLASE NUEVA QUE PISABA UNA VIEJA. `.ojo` ya era el botón «Ver» de las contraseñas;
   agregar otra regla `.ojo` más abajo le cambiaba fondo, padding y color en la pantalla de entrar.
   No lo vio ningún test: lo vio el navegador, buscando el aviso y encontrando el botón. */
check('el aviso de «todo el saldo» no usa la clase del botón de ver la clave',
  /<div class="avisotodo">/.test(htmlCaja)
  && !/\$\{TODO_EL_SALDO && !carga \? `<div class="ojo">/.test(htmlCaja));
check('y `.ojo` sigue siendo una sola cosa',
  (htmlCaja.match(/^\.ojo\{/gm) || []).length === 1);

/* 🔴 EL AVISO NO EXPLICABA NADA. Reportado el 4-sep-2026. Ahora nombra el número que puede
   cambiar, dice qué hace el casino y en qué caso sale distinto. */
check('el aviso habla del número que se está mostrando',
  /\$\{fmt\(v\)\} es lo que hay ahora/.test(htmlCaja));
check('y le habla distinto a un cajero que a un jugador',
  /si el cajero está cargando o cobrando fichas/.test(htmlCaja)
  && /si el jugador está jugando/.test(htmlCaja));

/* ── 7 · el historial de jugadas ────────────────────────────────────────────────────────────────
   🔴 EL NÚMERO GRANDE DECÍA LO CONTRARIO QUE LAS FILAS. El `profit` del motor es de la CASA
   —`apostado − ganado`—, comprobado el 4-sep-2026 sobre 10 sesiones reales sin una excepción:
   apostó 5.210, ganó 7.250, el motor manda −2.040. Se pintaba con «+» y en verde como si fuera
   del jugador. */
{
  /* Lo mismo que hace el conector al agrupar: el neto es SIEMPRE el del jugador. */
  const neto = (bet, win) => win - bet;
  check('el que pierde queda en negativo, no en positivo',
    neto(560, 236) === -324, String(neto(560, 236)));
  check('y el que gana, en positivo',
    neto(5210, 7250) === 2040, String(neto(5210, 7250)));
  check('el conector guarda el neto del jugador, no el del motor',
    /g\.profit = g\.win - g\.bet;/.test(conector)
    && !/g\.profit \+= plata\(f\.profit\)/.test(conector));
  check('y las dos pantallas dicen de quién es el número',
    (htmlCaja.match(/'Le quedó al jugador'/g) || []).length === 2
    && !/\['Resultado', \(tot\.profit/.test(htmlCaja)
    && !/\['Resultado', \(s\.profit/.test(htmlCaja));
}

/* 🔴 LA MATRIX NO LLEGA. El comentario decía que «algunos proveedores traen la grilla del slot y
   las líneas ganadoras» — y nada en el código leía jamás un campo así. Medido: el motor manda 21
   campos por jugada y ninguno es la grilla, las líneas ni un enlace al log. */
/* 🔴 ME EQUIVOQUÉ Y HAY QUE DEJARLO FIJADO. El 4-sep dije que el casino no daba la matriz: la
   lista de sesiones no la trae, pero la consulta de UNA sesión sí — misma área, un parámetro más.
   El dueño lo mostró abriendo el [LOG] del panel. */
check('la pantalla ya no dice que el casino no manda el detalle',
  !/algunos traen la grilla del/.test(htmlCaja)
  && !/no manda el detalle de cada tirada/.test(htmlCaja));
check('y ahora ofrece ver la matriz de cada jugada',
  /Tocá una jugada para ver <b>su grilla<\/b> o <b>su ID<\/b>/.test(htmlCaja)
  && /function dibujarMatriz\(j\)\{/.test(htmlCaja));
check('el detalle se pide con el id del motor, no con el hash de la sesión',
  /sesion: String\(ses\.idMotor\)/.test(conector) && /idMotor: String\(f\.id \|\| ''\)/.test(conector));
check('y se pide UNA vez por sesión, sólo al abrirla',
  /const clave = `ronda:\$\{sesionId\}`/.test(conector)
  && /cache\.has\(clave\)\) return abrirSesionOriginal/.test(conector));

/* ── 8 · las credenciales de un jugador ─────────────────────────────────────────────────────────
   🔴 OFRECÍA UN LINK QUE NO EXISTE, Y EL TELÉFONO SE QUEJABA. Reportado el 4-sep-2026: la tarjeta
   «Link para entrar directo» salía aunque la caja no tenga su dirección cargada — vacía, pero
   diciendo «lo toca y ya está adentro». Al tocarla, `navigator.share({text:''})` abría el menú de
   compartir del sistema operativo con nada adentro y contestaba «Inténtalo de nuevo». Ese cartel
   lo pone el teléfono, no la página: el `.catch` no lo tapa. */
/* 🔴 LA REGLA, EN UN SOLO LUGAR. Pedido del dueño el 4-sep-2026: «a veces va a pasar que no
   tienen el link; tiene que haber un filtro para no dar la opción de copiar el ticket si no hay
   URL puesta». No alcanza con arreglar la pantalla que se reportó: mientras el link se pueda
   dibujar con `filaCred`, la próxima pantalla se olvida del filtro. */
check('ninguna pantalla dibuja un link con filaCred: todas pasan por filaLink',
  (htmlCaja.match(/filaCred\('Link de acceso directo'/g) || []).length === 1   // la de adentro de filaLink
  && !/filaCred\('Link de acceso directo'/.test(conector));
check('y filaLink decide por las dos: fila si hay, explicación si no',
  /function filaLink\(link\)\{\n\s*if \(link\) return filaCred/.test(htmlCaja));
check('las cuatro pantallas que muestran un link usan la regla',
  (htmlCaja.match(/filaLink\(/g) || []).length >= 4
  && (conector.match(/filaLink\(/g) || []).length === 2);

check('la tarjeta del link sólo se dibuja si hay link',
  /\$\{e\.link\s*\n?\s*\? tarjeta\('link'/.test(htmlCaja));
check('y si no hay, se explica en vez de dejar un hueco',
  /window\.SIN_LINK/.test(htmlCaja));
check('nunca se comparte un texto vacío',
  /if \(!texto\) return;[\s\S]{0,200}navigator\.share/.test(htmlCaja));

/* Un solo texto para «no hay link»: el conector lo expone y la pantalla lo usa. La pantalla
   igual guarda una copia para la maqueta, que corre sin conector — y ésa es la que se queda
   vieja. Así que no se cuentan copias: se comparan LETRA POR LETRA. */
{
  const soloTexto = (f) => (f.match(/'(?:[^'\\]|\\.)*'/g) || [])
    .map((t) => t.slice(1, -1)).join('').replace(/\s+/g, ' ').trim();
  const delConector = soloTexto((conector.match(/const SIN_LINK = [\s\S]*?;\n/) || [''])[0]);
  const deLaPantalla = soloTexto((htmlCaja.match(/\|\| 'Se puede[\s\S]*?\}<\/div>/) || [''])[0]
    .replace(/\}<\/div>/, ''));
  check('el conector expone el texto de «sin link»',
    /window\.SIN_LINK = SIN_LINK;/.test(conector) && delConector.length > 30, delConector);
  check('y la copia de la maqueta dice exactamente lo mismo',
    deLaPantalla === delConector, deLaPantalla || 'no se encontró la copia');
}

/* ── 9 · la tira de períodos ────────────────────────────────────────────────────────────────────
   🔴 «Otro rango…» es el último de seis botones y la tira se desplaza de costado: en un teléfono
   el botón que lleva las fechas elegidas quedaba fuera de pantalla, y la tira parecía no tener
   nada marcado. Medidas de un teléfono real: tira de 343 px de ancho, 470 px de botones. */
const TIRA = { scroll: 0, ancho: 343, total: 470 };
const OTRO_RANGO = { izq: 360, ancho: 104 };   // el último, arrancando fuera de la vista
const HOY = { izq: 0, ancho: 44 };

check('el botón que no entra hace que la tira se corra',
  L.desplazarHastaElegido(OTRO_RANGO, TIRA) !== null,
  String(L.desplazarHastaElegido(OTRO_RANGO, TIRA)));
check('y después de correrse, se ve entero',
  (() => { const d = L.desplazarHastaElegido(OTRO_RANGO, TIRA);
    return OTRO_RANGO.izq >= d && OTRO_RANGO.izq + OTRO_RANGO.ancho <= d + TIRA.ancho; })());
check('nunca se pasa del final de la tira',
  L.desplazarHastaElegido(OTRO_RANGO, TIRA) <= TIRA.total - TIRA.ancho,
  `${L.desplazarHastaElegido(OTRO_RANGO, TIRA)} ≤ ${TIRA.total - TIRA.ancho}`);

/* La otra mitad: si ya se ve, NO se mueve. Moverla igual le pelea el dedo a quien la desplaza. */
check('el botón que ya está a la vista no mueve nada',
  L.desplazarHastaElegido(HOY, TIRA) === null);
check('y si la tira entera entra en pantalla, tampoco',
  L.desplazarHastaElegido(OTRO_RANGO, { scroll: 0, ancho: 600, total: 470 }) === null);
check('vuelto ya al principio, «Hoy» no la vuelve a correr',
  L.desplazarHastaElegido(HOY, { scroll: 0, ancho: 343, total: 470 }) === null);

/* Si ya está desplazada a la derecha y se elige el primero, tiene que volver. */
check('elegir el primero desde el final trae la tira de vuelta',
  L.desplazarHastaElegido(HOY, { scroll: 127, ancho: 343, total: 470 }) === 0,
  String(L.desplazarHastaElegido(HOY, { scroll: 127, ancho: 343, total: 470 })));

check('sin medidas no se toca nada, en vez de romper',
  L.desplazarHastaElegido(null, TIRA) === null
  && L.desplazarHastaElegido(HOY, { scroll: 0, ancho: 0, total: 0 }) === null);

check('la pantalla usa esa función y no su propia cuenta',
  /desplazarHastaElegido\(\s*\n?\s*\{ izq: b\.offsetLeft/.test(htmlCaja));
/* 🔑 rAF sólo corre si la página pinta: en una pestaña de fondo la tira nunca se acomodaría. */
check('y no depende de que la página esté pintando',
  /setTimeout\(\(\) => \{\n\s*document\.querySelectorAll\('\.periodos'\)/.test(htmlCaja)
  && !/requestAnimationFrame\(\(\) => \{\n\s*document\.querySelectorAll\('\.periodos'\)/.test(htmlCaja));

/* 🔴 LA FILA Y SU GRILLA TIENEN QUE CONTAR IGUAL. El 7-sep agregué una flecha a la fila sin
   agregarle su columna: el cuarto elemento se fue al renglón de abajo y la fila quedó rota. */
/* 🔴 EL ANCHO FIJO SE COMÍA EL NOMBRE. En una columna de 292 px el nombre recibía 29 de los 153
   que necesitaba: el 19%. El saldo tiene que ceder antes que el nombre. */
check('el nombre tiene un mínimo y el saldo puede achicarse',
  /grid-template-columns:auto minmax\(80px, 1fr\) auto minmax\(0, 190px\)/.test(htmlCaja));

check('la fila lleva su flecha y la grilla le hace lugar',
  /<span class="fl" aria-hidden="true">›<\/span>\n\s*<button class="bal"/.test(htmlCaja)
  && /grid-template-columns:auto minmax\(80px, 1fr\) auto minmax\(0, 190px\)/.test(htmlCaja));

/* ── 10 · vaciar los ejemplos no puede romper la estructura ──────────────────────────────────────
   🔴 EL QUE IMPEDÍA ABRIR CUALQUIER JUGADOR. Al entrar se tiran los datos de ejemplo; el barrido
   borraba TODAS las claves de `MOVS`, incluidas `agente` y `cajero`, que no son ejemplo sino los
   cajones. Después, la ficha de un jugador lee `MOVS.cajero['usual:players']` sobre `undefined` y
   revienta: no abría ni el historial, ni las credenciales, ni el cambio de contraseña.
   Visto en producción con la sesión real el 7-sep-2026. */
{
  /* Se ejecuta el barrido de verdad, sobre un MOVS con la misma forma que el de la pantalla. */
  const MOVS = { agente: { 'usual:to': [1, 2] }, cajero: { 'usual:players': [3] } };
  const JUGADAS = { '595': [1] };
  /* Se corta justo ANTES del `} catch` para que el trozo quede balanceado: el `try` que lo abre
     está fuera del recorte. */
  const desde = conector.indexOf('const m = window.MOVS');
  const barrido = conector.slice(desde, conector.indexOf('} catch (e) { /* si no existe', desde));
  // eslint-disable-next-line no-new-func
  new Function('MOVS', barrido.replace("window.MOVS || eval('MOVS')", 'MOVS'))(MOVS);
  check('quedan los cajones de MOVS después de tirar los ejemplos',
    MOVS.cajero && typeof MOVS.cajero === 'object' && MOVS.agente && typeof MOVS.agente === 'object',
    JSON.stringify(Object.keys(MOVS)));
  check('pero adentro no queda ningún movimiento de ejemplo',
    Object.keys(MOVS.cajero).length === 0 && Object.keys(MOVS.agente).length === 0);
  check('y leer las jugadas de un jugador no puede tirar la ficha',
    (() => { try { return (((MOVS.cajero || {})['usual:players'] || []).length) === 0; }
             catch (e) { return false; } })());
  check('la pantalla además lee a la defensiva',
    /\(\(MOVS\.cajero \|\| \{\}\)\['usual:players'\] \|\| \[\]\)/.test(htmlCaja));
  void JUGADAS;
}

/* ── 11 · lo que lee el cliente no es el diario de obra ─────────────────────────────────────────
   🔴 Se le mostró a un cajero, adentro de una «i», un texto que decía «el 4-sep dije que el casino
   no la daba, estaba equivocado… el dueño lo mostró abriendo el [LOG]». Eso es mi cambio de
   opinión, no información para quien está trabajando. Las notas explican CÓMO USAR la pantalla y
   qué límites tiene; el porqué histórico va en los comentarios del código, que el cliente no ve. */
{
  const visibles = [...htmlCaja.matchAll(/notaInfo\(\s*'([^']+)'\s*,([\s\S]{0,1600}?)\)\}/g)];
  const prohibidas = /(dije que|equivocad|el dueño|reportad|medido el|\d-sep-20\d\d|\[LOG\])/i;
  const sucias = visibles
    .map(([, clave, cuerpo]) => [clave, cuerpo.replace(/\/\*[\s\S]*?\*\//g, '')])
    .filter(([, cuerpo]) => prohibidas.test(cuerpo))
    .map(([clave]) => clave);
  check('ninguna nota le cuenta al cliente la historia del arreglo',
    sucias.length === 0, sucias.length ? sucias.join(', ') : `${visibles.length} notas limpias`);
  /* 🔴 El aviso invitaba a tocar una jugada aunque el juego no mandara nada: se tocaba y no pasaba
     nada. Ahora hay dos textos y se elige por lo que de verdad llegó. */
  check('sólo se ofrece la matriz cuando alguna jugada la trae',
    /const hayMatriz = js\.some\(x => x\.matriz \|\| \(x\.lineas && x\.lineas\.length\)\);/.test(htmlCaja)
    && /hayMatriz\n\s*\? 'Tocá una jugada para ver <b>su grilla<\/b>/.test(htmlCaja));
  check('y si no la trae, se ofrece igual el ID para soporte',
    /: 'Tocá una jugada para ver <b>su ID<\/b>\.'/.test(htmlCaja));

  /* 🔴 TRES CAJAS DE TEXTO DEBAJO DE UN RENGLÓN DE DATOS. La pantalla explicaba cómo manda los
     datos el casino —que parte la jugada en dos registros, que hay movimientos de mesa, por qué
     faltan las figuras— y eso tapaba lo único que el cajero vino a mirar. Revisado con el dueño el
     9-sep-2026: «están dando muchas vueltas y explicando cosas que los clientes no tienen que
     saber». Todo eso vive ahora detrás de la (i). */
  check('el detalle de la sesión no repite avisos sueltos debajo de las jugadas',
    !/Este proveedor <b>parte cada jugada/.test(htmlCaja)
    && !/Se dejaron afuera <b>\$\{deMesa\}/.test(htmlCaja));
  /* Y para que no vuelva a crecer: lo que se VE de una nota entra en un renglón o dos. El porqué
     va en el segundo argumento, que sólo se abre si lo tocan. */
  {
    /* Se mide lo que se LEE, no el código: de la primera mitad de cada `notaInfo` se juntan los
       pedazos de texto entre comillas y se descuentan las etiquetas. Contar el fuente marcaría
       como larga una nota corta escrita con un ternario. */
    const loQueSeLee = (fuente) => (fuente.match(/'[^']*'|"[^"]*"|`[^`]*`/g) || [])
      .map((t) => t.slice(1, -1).replace(/\$\{[^}]*\}/g, '×'))
      .join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const largas = [...htmlCaja.matchAll(/notaInfo\(\s*'([^']+)',([\s\S]{0,900}?),\n\s{4,}'/g)]
      .map(([, clave, corto]) => [clave, loQueSeLee(corto)])
      .filter(([, corto]) => corto.length > 170)
      .map(([clave, corto]) => `${clave} (${corto.length})`);
    /* Y el propio medidor tiene que estar midiendo algo: si un cambio de forma lo dejara sin
       encontrar ninguna nota, este check pasaría en verde sin haber mirado nada. */
    const medidas = [...htmlCaja.matchAll(/notaInfo\(\s*'([^']+)',([\s\S]{0,900}?),\n\s{4,}'/g)].length;
    check('y lo que se ve de cada nota entra en un par de renglones',
      medidas >= 10 && largas.length === 0,
      largas.length ? largas.join(', ') : `${medidas} notas medidas, todas cortas`);
  }

  /* 🔴 Antes sólo se abrían las jugadas con grilla, así que en los juegos que no la mandan no
     había nada para tocar. Adentro siempre hay algo: el desglose y el número para soporte. */
  check('toda jugada se puede abrir, traiga grilla o no',
    /<div class="jug jug-toca" role="button" tabindex="0"/.test(htmlCaja)
    && !/jug \$\{hayDetalle \? 'jug-toca' : ''\}/.test(htmlCaja));
  check('y adentro va el ID de la jugada, copiable',
    /filaCred\('ID de la jugada', x\.idSoporte, true\)/.test(htmlCaja));
  /* El aviso y el recuadro tienen que llamarlo IGUAL: si uno dice «número» y el otro «ID», el
     cajero termina buscando dos cosas distintas. «ID» es la palabra con la que soporte lo pide. */
  check('y el aviso lo llama igual que el recuadro',
    /ver <b>su ID<\/b>/.test(htmlCaja) && !/su número<\/b>/.test(htmlCaja));
  check('y detrás de la (i) sigue estando el para qué y el qué hacer',
    /te dice <b>por qué '\s*\+ 'se le pagó eso<\/b>/.test(htmlCaja)
    && /escribinos a '\s*\+ 'soporte y buscamos la jugada exacta/.test(htmlCaja));
}

/* 🔴 EL CALLBACK QUE NO RECIBÍA NADA. `pedirUnaVez` guarda la respuesta y llama al callback SIN
   argumentos. Escrito como `(d) => …`, `d` llegaba `undefined` y las rondas no se cargaban nunca:
   la matriz no abría aunque el servidor la devolviera bien. */
/* Y se EJECUTA el `pedirUnaVez` de verdad, recortado del conector, para probar el contrato: si
   alguna vez pasara la respuesta como argumento, este test lo diría en vez de fallar en pantalla. */
{
  const desde = conector.indexOf('function pedirUnaVez(');
  const codigo = conector.slice(desde, conector.indexOf('\n  }', desde) + 4);
  const cache = new Map(); const yaPedido = new Set();
  // eslint-disable-next-line no-new-func
  const hacer = new Function('cache', 'yaPedido', codigo + '; return pedirUnaVez;')(cache, yaPedido);
  let argumentos = null; let listo;
  const esperar = new Promise((r) => { listo = r; });
  hacer('k', () => Promise.resolve({ ok: true, rondas: [{ id: '1' }] }),
    function (...args) { argumentos = args; listo(); });
  await esperar;
  check('pedirUnaVez llama al callback SIN argumentos',
    argumentos && argumentos.length === 0, `recibió ${argumentos ? argumentos.length : '?'}`);
  check('y deja la respuesta en la caché, que es de donde hay que leerla',
    cache.get('k') && cache.get('k').rondas.length === 1);
}

check('el detalle de la ronda se lee de la caché, no de un argumento que no llega',
  /\}\), \(\) => \{[\s\S]{0,600}?const d = cache\.get\(clave\);/.test(conector)
  && !/\}\), \(d\) => \{\n\s*cache\.set\(clave, d\);/.test(conector));

/* ── 12 · volver al login tiene que dejar entrar ────────────────────────────────────────────────
   🔴 EL QUE DEJABA LA PANTALLA SIN CAMPO DE CONTRASEÑA. Al entrar, ese campo se QUITA del
   documento —es lo único que calla el «¿querés guardar la contraseña?» de Chrome— y se reponía
   sólo al tocar «Salir». Cuando la sesión vencía, se volvía al login con el cartel «entrá de
   nuevo» y sin campo donde escribir: la única salida era recargar la página.
   Visto en producción el 7-sep-2026 con la sesión del dueño. */
check('al vencerse la sesión se repone el campo de la contraseña',
  /function volverAlLogin\(aviso\) \{[\s\S]{0,400}?apagarLogin\(false\);/.test(conector));
check('y se vuelve a poner el usuario que ya estaba guardado',
  /if \(u && !u\.value && ultimo\) u\.value = ultimo;/.test(conector));
check('el campo se quita al entrar y se guarda para reponerlo, no se destruye',
  /campoClaveGuardado = \{ el: p, donde: p\.parentNode, antes: p\.nextSibling \}/.test(conector)
  && /donde\.insertBefore\(el, antes\)/.test(conector));

/* 🔴 LOS RÓTULOS OCUPABAN MÁS QUE LOS NÚMEROS. Cada renglón repetía «Apostó … · ganó …», más
   ancho que el dato. Ahora los rótulos van una vez, como encabezado, y las cifras en columna. */
check('las jugadas se leen en columnas, con el rótulo una sola vez',
  /<div class="jug-cab"><span>Hora<\/span><span>Apostó<\/span><span>Ganó<\/span><span>Neto<\/span><\/div>/.test(htmlCaja)
  && !/<b>Apostó <span class="num">/.test(htmlCaja));
check('y cada fila lleva las tres cifras alineadas',
  /<span class="num apo">/.test(htmlCaja)
  && /<span class="num gan /.test(htmlCaja)
  && /<span class="num net /.test(htmlCaja));
check('sin premio se muestra una raya, no un cero que parece un dato',
  /\$\{x\.win \? fmt\(x\.win\) : '—'\}/.test(htmlCaja));

/* ── 13 · la matriz llega de dos formas ─────────────────────────────────────────────────────────
   🔴 Medido el 7-sep-2026 comparando dos juegos de la MISMA instalación: un PRAGMATIC devolvió
   `matrix` como objeto y las líneas en `winLines`; un RUBYPLAY (XG) devolvió `matrix` como TEXTO
   con JSON adentro, las líneas en `win_lines` y los símbolos como texto. Leíamos sólo la primera,
   así que justo los juegos que SÍ traen las figuras no mostraban nada. */
{
  const rutas = require('fs').readFileSync(__dirname + '/../src/caja/caja.routes.js', 'utf8');
  check('la matriz se parsea venga como objeto o como texto',
    /const mat = comoJson\(f\.matrix\) \|\| \{\};/.test(rutas));
  check('y las líneas se leen con los dos nombres',
    /comoJson\(f\.winLines\) \|\| comoJson\(f\.win_lines\)/.test(rutas));
  check('la dirección de las figuras la manda el motor, no se arma acá',
    /figuras: grilla && mat\.imgUrl \? String\(mat\.imgUrl\) : null/.test(rutas));
  check('la pantalla dibuja la figura y deja el símbolo igual',
    /<img src="\$\{j\.figuras\}\$\{encodeURIComponent\(sim\)\}\.png"/.test(htmlCaja)
    && /onerror="this\.remove\(\)"/.test(htmlCaja)
    /* Sin `lazy`: la matriz se abre con un gesto deliberado y son pocas imágenes; diferirlas deja
       la grilla en blanco hasta que alguien la desplaza. */
    && !/loading="lazy"[\s\S]{0,80}onerror="this\.remove\(\)"/.test(htmlCaja)
    && /<i>\$\{sim\}<\/i>/.test(htmlCaja)
    /* Y el multiplicador de una celda, que en 3OAKS explica el pago. */
    && /mult \? `<em>×\$\{mult\}<\/em>` : ''/.test(htmlCaja));
}

/* 🔴 EL NÚMERO PARA SOPORTE SE ELIGE, NO SE INVENTA. El motor manda hasta tres identificadores
   según el proveedor; se usa el más específico que haya y, si no vino ninguno, no se muestra
   nada — un número inventado hace perder más tiempo que no tener ninguno. */
{
  const rutas = require('fs').readFileSync(__dirname + '/../src/caja/caja.routes.js', 'utf8');
  check('se prefiere el ticket, después la transacción, después la ronda, después el id del motor',
    /idSoporte: String\(f\.bet_id \|\| f\.trade_id \|\| \(comoJson\(f\.info\) \|\| \{\}\)\.round_id \|\| f\.id \|\| ''\) \|\| null/.test(rutas));
  /* 🔴 Una apuesta deportiva no tiene grilla y no le hace falta: lo que explica el pago es el
     cupón —qué partido, qué evento, a qué cuota—, y el motor lo manda en `info`. */
  check('una apuesta deportiva pasa su cupón, no una grilla vacía',
    /Array\.isArray\(i\) && i\.length && i\[0\] && i\[0\]\.GameName \? i : null/.test(rutas));
  check('y la pantalla lo dibuja como cupón',
    /function dibujarApuesta\(j\)\{/.test(htmlCaja)
    && /x\.apuestas \? dibujarApuesta\(x\)/.test(htmlCaja));
}

/* ── 14 · cada sello manda la matriz a su manera ────────────────────────────────────────────────
   Muestras REALES, sacadas el 8-sep-2026 jugando una ronda con cada proveedor y leyendo la
   respuesta cruda del motor. No son inventadas: si el motor cambia, estos datos quedan viejos y
   hay que volver a sacarlos igual. */
const MUESTRAS = {
  egt: {  // SL · números, `winLines`, celdas [a,b]
    matriz: [[2,8,0,1,0],[2,8,2,6,5],[0,8,2,4,1]],
    lineas: [{ line:1, symbol:2, count:3, side:'left', cash:5, xWin:1, elements:[[1,2],[2,2],[3,2]] }],
  },
  oaks: { // SL2 · símbolos OBJETO mezclados con números, claves cortas
    matriz: [[{image:'10',value:30},2,7],[{image:'10',value:30},2,3],[7,2,6],[1,12,6],[4,4,6]],
    lineas: [{ s:'12', c:3, w:60, e:[[0,0],[0,1],[1,3]] }],
  },
  ruby: { // XG · textos, `win_lines`, celdas [a,b,bandera]
    matriz: [['2','0','5','5','5'],['8','8','7','5','5'],['5','3','5','5','5']],
    lineas: [{ line:19, symbol:'5', count:5, cash:800, xWin:16,
      elements:[[0,2,1],[1,0,1],[2,2,1],[3,0,1],[4,2,1],[0,0,0]] }],
  },
  ains: { // XG · textos con letras, líneas como OBJETO indexado
    matriz: [['Tn','Jk','Dr','Qn','Sr'],['Cn','Ty','Dr','Cn','Ae'],['Ae','Ae','Dr','Ht','Ht']],
    lineas: { '2': { line:3, symbol:'Ae', count:3, cash:250, xWin:5,
      elements:[[0,2,1],[1,2,1],[2,2,1],[3,2,0],[4,2,0]] } },
  },
};

/* 🔴 UN SÍMBOLO QUE ES OBJETO SE DIBUJABA «[object Object]». */
check('un símbolo objeto muestra su figura, no «[object Object]»',
  L.simboloDeCelda({ image: '10', value: 30 }) === '10'
  && L.simboloDeCelda(7) === '7' && L.simboloDeCelda('Ae') === 'Ae',
  L.simboloDeCelda({ image: '10', value: 30 }));
check('y su multiplicador se puede mostrar aparte',
  L.multiplicadorDeCelda({ image: '10', value: 30 }) === 30
  && L.multiplicadorDeCelda(7) === null);

/* 🔴 UNA LISTA DE LÍNEAS QUE ES OBJETO NO SE PODÍA RECORRER. */
check('las líneas se leen vengan como lista o como objeto indexado',
  L.normalizarLineas(MUESTRAS.ruby.lineas).length === 1
  && L.normalizarLineas(MUESTRAS.ains.lineas).length === 1,
  `${L.normalizarLineas(MUESTRAS.ains.lineas).length} de AINSWORTH`);
check('y con nombres cortos o largos dan lo mismo',
  (() => { const a = L.normalizarLineas(MUESTRAS.oaks.lineas)[0];
    return a.simbolo === '12' && a.cuantos === 3 && a.pago === 60 && a.celdas.length === 3; })());

/* 🔴 SÓLO SE MARCA LO QUE SE PUEDE PROBAR. */
{
  const m = (k) => L.celdasGanadoras(L.normalizarLineas(MUESTRAS[k].lineas), MUESTRAS[k].matriz);
  const contiene = (set, matriz, simbolo) => [...set].every((k) => {
    const [f, c] = k.split(':').map(Number);
    return L.simboloDeCelda(matriz[f][c]) === simbolo;
  });
  const ruby = m('ruby');
  check('RUBYPLAY: marca las celdas que de verdad tienen el símbolo que pagó',
    ruby.size === 4 && contiene(ruby, MUESTRAS.ruby.matriz, '5'), `${ruby.size} celdas`);
  const ains = m('ains');
  check('AINSWORTH: idem, con símbolos de letras',
    ains.size === 2 && contiene(ains, MUESTRAS.ains.matriz, 'Ae'), `${ains.size} celdas`);
  const oaks = m('oaks');
  check('3OAKS: marca el símbolo real y no los comodines que lo completan',
    oaks.size === 1 && contiene(oaks, MUESTRAS.oaks.matriz, '12'), `${oaks.size} celdas`);
  /* Yo esperaba que EGT no cerrara con ninguna lectura. Me equivoqué: cierra con [columna,fila]
     base 1, y marca las DOS celdas que tienen el 2. La tercera de la línea es un comodín que la
     completa sin ser el símbolo, y queda sin marcar — que es exactamente lo que se busca. */
  const egt = m('egt');
  check('EGT: marca las dos celdas con el símbolo y deja el comodín sin marcar',
    egt.size === 2 && contiene(egt, MUESTRAS.egt.matriz, '2'), `${egt.size} celdas`);
  check('nunca se marca una celda que no tenga el símbolo',
    [['ruby','5'],['ains','Ae'],['oaks','12'],['egt','2']]
      .every(([k, sim]) => contiene(m(k), MUESTRAS[k].matriz, sim)));
}

check('sin grilla no se marca nada, en vez de romper',
  L.celdasGanadoras(MUESTRAS.ruby.lineas, null).size === 0
  && L.celdasGanadoras(null, MUESTRAS.ruby.matriz).size === 0);

/* 🔴 UNA RONDA DEVUELTA NO ES UNA RONDA PERDIDA. El casino en vivo (Jacktop) manda `refund`, que
   ningún otro sello trae. Medido el 8-sep-2026 sobre cuatro ruletas: sin mirarlo, «apostó 100 ·
   ganó 0» se lee como una pérdida de 100 aunque la mesa haya anulado la ronda. */
{
  const rutas = require('fs').readFileSync(__dirname + '/../src/caja/caja.routes.js', 'utf8');
  check('una ronda devuelta se pasa a la pantalla',
    /devuelta: \(f\.refund != null && !\/\^\(no\|0\|false\|\)\$\/i\.test/.test(rutas));
  check('y «no» no cuenta como devuelta',
    /\^\(no\|0\|false\|\)\$/.test(rutas));
  check('la pantalla lo dice sin tocar los números del casino',
    /El casino marcó esta ronda como/.test(htmlCaja)
    && /El neto de arriba es el que/.test(htmlCaja));
}

/* ── 15 · el casino en vivo parte la jugada en dos ──────────────────────────────────────────────
   🔴 Señalado por el dueño el 8-sep-2026: «si vuelve 0 no significa que no pagó, la ganancia
   aparece en otra línea». Datos REALES de una sesión de Absolute Live Gaming: 9 renglones, de los
   cuales 7 son movimientos de mesa (todo en cero, sin `round_id`) y los otros 2 son la MISMA
   jugada — la apuesta a las 22:54:12 y el pago a las 22:54:43. */
{
  const crudas = [
    { round_id:'19800857786', esJugada:false, dateTime:'2026-09-08 22:56:34', before:4971.10, bet:0, win:0 },
    { round_id:'19800848792', esJugada:false, dateTime:'2026-09-08 22:55:40', before:4971.10, bet:0, win:0 },
    { round_id:'19800840372', esJugada:false, dateTime:'2026-09-08 22:54:48', before:4971.10, bet:0, win:0 },
    { round_id:'18202600295801', esJugada:true, dateTime:'2026-09-08 22:54:43', before:4971.10, bet:0, win:720 },
    { round_id:'18202600295801', esJugada:true, dateTime:'2026-09-08 22:54:12', before:4251.10, bet:20, win:0 },
    { round_id:'19800831789', esJugada:false, dateTime:'2026-09-08 22:53:56', before:4271.10, bet:0, win:0 },
    { round_id:'19800831788', esJugada:false, dateTime:'2026-09-08 22:53:51', before:4271.10, bet:0, win:0 },
    { round_id:'19800831787', esJugada:false, dateTime:'2026-09-08 22:53:43', before:4271.10, bet:0, win:0 },
    { round_id:'19800831786', esJugada:false, dateTime:'2026-09-08 22:53:41', before:4271.10, bet:0, win:0 },
  ];
  const jugables = crudas.filter((x) => x.esJugada !== false);
  check('los movimientos de mesa quedan afuera',
    jugables.length === 2 && crudas.length - jugables.length === 7,
    `${jugables.length} jugadas de ${crudas.length} renglones`);

  /* Se ejecuta el `agruparJugadas` de verdad, recortado de la pantalla. */
  const desde = htmlCaja.indexOf('function agruparJugadas(filas){');
  const codigo = htmlCaja.slice(desde, htmlCaja.indexOf('\n}', desde) + 2);
  // eslint-disable-next-line no-new-func
  const agrupar = new Function(codigo + '; return agruparJugadas;')();
  const js = agrupar(jugables);
  check('la apuesta y su pago se juntan en UNA jugada',
    js.length === 1, `${js.length} jugadas`);
  check('y esa jugada dice lo que de verdad puso y se llevó',
    js[0].bet === 20 && js[0].win === 720 && js[0].win - js[0].bet === 700,
    `apostó ${js[0].bet}, ganó ${js[0].win}, neto ${js[0].win - js[0].bet}`);
  /* 🔴 El saldo de antes es el de la primera línea, no el mayor: acá el máximo daría 4.971,10,
     que es el saldo DESPUÉS de cobrar los 720. */
  check('el saldo de antes es el de antes de apostar, no el de después de cobrar',
    js[0].before === 4251.10, String(js[0].before));
  check('y la hora es la de la apuesta, no la del pago',
    js[0].dateTime === '2026-09-08 22:54:12', js[0].dateTime);

  /* 🔴 EL CONTADOR SE LLAMABA `lineas` Y SE COMÍA LAS LÍNEAS GANADORAS. `agruparJugadas` arrancaba
     cada ronda con `lineas:0` y le sumaba uno por registro, pisando lo que manda el motor en
     `winLines` —qué símbolo pagó y en qué posiciones—. La grilla se dibujaba igual, así que no se
     notaba: simplemente NINGUNA celda quedaba en verde y el renglón «Símbolo × 3 · línea 1» no
     salía nunca, en ningún proveedor. Encontrado el 9-sep-2026 mirando la pantalla, no el código.
     🔑 Y el resultado viaja en el registro del PAGO, no en el de la apuesta: agrupar quedándose
     con los campos del primero era quedarse justo con los vacíos. */
  const partida = [
    { round_id:'36352824005', dateTime:'2026-09-08 22:54:12', before:320, bet:30, win:0,
      matriz:null, lineas:[], idSoporte:'' },
    { round_id:'36352824005', dateTime:'2026-09-08 22:54:43', before:290, bet:0, win:90,
      matriz:[[1,2,3],[4,5,1],[1,1,6]], figuras:'https://cdn/x/',
      lineas:[{ line:1, symbol:1, count:3, cash:90, elements:[[0,0],[1,2],[2,0]] }],
      idSoporte:'36352824005' },
  ];
  const unida = agrupar(partida)[0];
  check('agrupar NO se come las líneas ganadoras',
    Array.isArray(unida.lineas) && unida.lineas.length === 1,
    Array.isArray(unida.lineas) ? `${unida.lineas.length} línea` : `quedó ${typeof unida.lineas}`);
  check('y la grilla, las figuras y el número los toma del registro que los trae',
    !!unida.matriz && unida.figuras === 'https://cdn/x/' && unida.idSoporte === '36352824005',
    `matriz ${!!unida.matriz}, figuras ${!!unida.figuras}, número ${unida.idSoporte || '—'}`);
  check('y con esas líneas la pantalla puede marcar las celdas que pagaron',
    L.celdasGanadoras(L.normalizarLineas(unida.lineas), unida.matriz).size === 3,
    `${L.celdasGanadoras(L.normalizarLineas(unida.lineas), unida.matriz).size} celdas`);
}

/* ── 16 · las seis formas, contra el mapeo de verdad ────────────────────────────────────────────
   Se recorta el mapeo REAL de `/api/caja/ronda` y se le pasan rondas tal cual las devolvió el
   casino, una por sello. Si mañana alguien cambia ese mapeo pensando en un solo proveedor, esto
   dice cuál rompió. Las muestras salieron de jugar una ronda con cada uno, el 7 y 8-sep-2026. */
{
  const rutas = require('fs').readFileSync(__dirname + '/../src/caja/caja.routes.js', 'utf8');
  const desde = rutas.indexOf('rondas: (d.data.history || []).map((f) => {');
  const ini = rutas.indexOf('return {', desde);
  const objeto = rutas.slice(ini + 'return '.length, rutas.indexOf('}; }),', ini) + 1);
  const comoJson = (t) => {
    if (t == null || t === '') return null;
    if (typeof t === 'object') return t;
    try { return JSON.parse(t); } catch (e) { return null; }
  };
  // eslint-disable-next-line no-new-func
  const mapear = new Function('f', 'comoJson',
    'const mat = comoJson(f.matrix) || {}; '
    + 'const grilla = Array.isArray(mat.matrix) && mat.matrix.length ? mat.matrix : null; '
    + 'return ' + objeto + ';');

  const REALES = {
    'XG · RUBYPLAY': { id:'1935954461', bet:10, win:0, balance_before:609400,
      matrix:'{"matrix":[["1","4"],["6","7"]],"imgUrl":"https://cdn/x/","imgSize":69.6}',
      win_lines:[], date_time:'2026-09-04 15:41:57', trade_id:'7382837_TSoph_810033_178853' },
    'SL2 · 3OAKS': { id:'19757513207', bet:'20.00', win:'60.00', before:'6222.00',
      matrix:{ matrix:[[{ image:'10', value:30 }, 2]], imgUrl:'https://cdn/3oaks/', class:'slot' },
      winLines:[{ s:'12', c:3, w:60, e:[[0,0]] }], dateTime:'2026-09-07 09:35:00',
      info:'{"round_id":"1370639797"}' },
    'OP · RED TIGER': { id:'19672131407', bet:'70.00', win:'8.00', before:'6084.00',
      matrix:{}, winLines:[], dateTime:'2026-09-04 12:50:00', info:'{"round_id":36699859848}' },
    'ImperiumBet': { id:'3371000', balance_before:'4,671.10', bet:'100.00', win:'0.00',
      bet_id:'86827689699', datetime_bet:'2026-09-07 10:03:55',
      info:'[{"ChampName":"China Championship U20","Coef":3.62,"CouponType":"Single","Event":"W1",'
        + '"GameName":"Wuhan - Guangdong","IsLive":true,"Score":"0:0","SportName":"Football"}]' },
    'Jacktop': { id:'2190741708', balance_before:'4,471.10', bet:'100.00', win:'0.00',
      datetime_bet:'2026-09-08 22:29:00', refund:'no' },
    'TVBet': { id:'3832110124', balance_before:'4,471.10', bet:'500.00', win:'0.00',
      datetime_bet:'2026-09-08 23:00:52', refund:'no' },
  };
  const r = Object.fromEntries(Object.entries(REALES).map(([k, f]) => [k, mapear(f, comoJson)]));

  check('todas las formas dan una fecha y un número para soporte',
    Object.values(r).every((x) => x.cuando && x.idSoporte),
    Object.entries(r).filter(([, x]) => !x.cuando || !x.idSoporte).map(([k]) => k).join(',') || 'las seis');
  check('sólo los sellos con grilla traen matriz',
    !!r['XG · RUBYPLAY'].matriz && !!r['SL2 · 3OAKS'].matriz
    && !r['OP · RED TIGER'].matriz && !r.Jacktop.matriz && !r.TVBet.matriz);
  check('el número para soporte es el más específico de cada uno',
    r['XG · RUBYPLAY'].idSoporte.startsWith('7382837_')      // trade_id
    && r['SL2 · 3OAKS'].idSoporte === '1370639797'           // info.round_id
    && r.ImperiumBet.idSoporte === '86827689699'             // bet_id, el ticket
    && r.TVBet.idSoporte === '3832110124',                   // el id, que siempre está
    r.TVBet.idSoporte);
  check('la apuesta deportiva pasa su cupón y las demás no',
    !!r.ImperiumBet.apuestas && r.ImperiumBet.apuestas[0].SportName === 'Football'
    && !r.Jacktop.apuestas && !r['XG · RUBYPLAY'].apuestas);
  check('TVBet y Jacktop comparten forma: mismo mapeo, mismos campos',
    JSON.stringify(Object.keys(r.TVBet)) === JSON.stringify(Object.keys(r.Jacktop))
    && r.TVBet.devuelta === null && r.Jacktop.devuelta === null);
  check('y todas quedan marcadas como jugada, porque movieron fichas',
    Object.values(r).every((x) => x.esJugada === true));
}

/* ── 17 · el panel no le habla al programador ───────────────────────────────────────────────────
   🔴 Repasado entero con el dueño el 9-sep-2026: «notas sencillas, amigables, directas, sólo las
   útiles». Aparecieron dos que le contaban al cajero cómo funciona el motor —una decía «todavía no
   está mapeada del motor» y nombraba `area=buttons`, la otra citaba lo que contesta el motor— y
   varias que explicaban decisiones de diseño nuestras. Nada de eso lo puede usar quien atiende. */
{
  /* Las notas rosas SÍ hablan del motor, a propósito: son del prototipo y el conector las esconde
     en cuanto la app se enchufa. Lo mismo con la franja de arriba, que pasa a «En pruebas». Si
     alguna de esas dos cosas se rompe, la jerga aparece en la pantalla de un cajero. */
  check('el conector sigue escondiendo las notas del prototipo',
    /\.nota\.motor\{display:none !important\}/.test(conector));
  check('y sigue reemplazando la franja de arriba',
    /aviso\.innerHTML = '<b>En pruebas<\/b>/.test(conector));

  /* Y en todo lo demás no puede quedar jerga. Se sacan comentarios, estilos y las notas rosas, y
     se marca sólo lo que además tiene prosa en castellano: así un `round_id:` de una estructura de
     datos no cuenta, pero «se juntan por round_id» escrito para leer, sí. */
  const visible = htmlCaja
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style>[\s\S]*?<\/style>/g, ' ')
    .replace(/<div class="nota motor"[^>]*>[\s\S]*?<\/div>/g, ' ')
    .replace(/<div class="aviso">[\s\S]*?<\/div>/g, ' ');
  const jerga = /(\bel motor\b|\bdel motor\b|\barea=|round_id|balanceTypes|statistic_type|dashboardinfo|main\.group|total\.ARS|winLines|imgUrl|mapead|\bendpoint\b|\bparámetro\b)/i;
  const prosa = / (el|la|los|las|de|que|se|con|para|una|un) /i;
  const sucias = visible.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => jerga.test(l) && prosa.test(l))
    .map(([n, l]) => `línea ${n}: ${l.trim().slice(0, 70)}`);
  check('ninguna frase que lea el cajero nombra el motor por dentro',
    sucias.length === 0, sucias.length ? sucias.join(' | ') : 'ninguna');
}

/* ── 18 · que la pantalla se adapte a la pantalla ───────────────────────────────────────────────
   🔴 FALTABA LA LÍNEA QUE HACE QUE TODO LO DEMÁS SIRVA. Sin `viewport`, un teléfono arma la página
   como si midiera 980px y después la achica entera: se ve chica y, peor, NINGUNA regla por tamaño
   de pantalla se cumple, porque el teléfono se cree ancho. Medido el 9-sep-2026 emulando 375px:
   `innerWidth` contestaba 980 y el panel entraba por la rama de tablet. */
{
  const meta = (htmlCaja.match(/<meta name="viewport"[^>]*>/) || [''])[0];
  check('la página le dice al teléfono que use el ancho del teléfono',
    /width=device-width/.test(meta) && /initial-scale=1/.test(meta), meta || 'no está');
  /* El diseño ya usaba `env(safe-area-inset-bottom)` para no meter los botones abajo de la barra
     del iPhone, y ese valor da CERO si no se pide `viewport-fit=cover`. */
  check('y pide el borde completo, que es de donde sale el margen de la barra del iPhone',
    /viewport-fit=cover/.test(meta) && /env\(safe-area-inset-bottom\)/.test(htmlCaja));

  /* Un solo ancho para el marco, la hoja y la barra de acción. Estaban los tres escritos a mano
     y tenían que coincidir; el día que uno cambiaba, la hoja quedaba despegada de la columna. */
  check('el ancho se decide en un solo lugar',
    /--ancho:440px/.test(htmlCaja)
    && /\.marco\{max-width:var\(--ancho\)/.test(htmlCaja)
    && /\.hoja\{[^}]*max-width:var\(--hoja\)/.test(htmlCaja)
    && /max-width:calc\(var\(--ancho\) - var\(--riel\)\)/.test(htmlCaja));
  const anchosSueltos = (htmlCaja.match(/max-width:\s*440px/g) || []).length;
  check('y ya no hay un 440 suelto por ahí', anchosSueltos === 0, `${anchosSueltos} sueltos`);

  check('hay tres escalones: teléfono, tablet y escritorio',
    /@media \(min-width:720px\)\{ :root/.test(htmlCaja)
    && /@media \(min-width:1100px\)\{ :root/.test(htmlCaja));
  /* En escritorio la tira de secciones deja de ser una tira: se para de costado. */
  check('en escritorio las secciones van al costado',
    /@media \(min-width:1100px\)\{\n\s*\.marco\{display:grid/.test(htmlCaja)
    && /\.secs\{grid-column:1; grid-row:3; flex-direction:column/.test(htmlCaja));
  /* Y la hoja deja de subir desde abajo, que es el gesto del pulgar. */
  check('y la hoja se centra en vez de subir desde el borde',
    /@media \(min-height:640px\) and \(min-width:760px\)/.test(htmlCaja)
    && /\.hoja\{bottom:auto; top:50%/.test(htmlCaja));
}

const fallaron = verificaciones.filter((v) => !v.ok);
console.log(`\n${verificaciones.length - fallaron.length}/${verificaciones.length} verificaciones pasaron`);
if (fallaron.length) {
  console.log('Fallaron:\n' + fallaron.map((v) => '  · ' + v.nombre).join('\n'));
  process.exit(1);
}
})();
