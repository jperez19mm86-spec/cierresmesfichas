/**
 * chat-avisos.service.js — LO QUE EL CHAT EXTERNO LE AVISA A ELLA.
 *
 * Dos cosas, las dos hacia ADENTRO (al grupo de la matriz). Acá no se le escribe nunca a un
 * cliente: este archivo no toca `chat.destino()` ni `chat.botToken()`, y esa ausencia es a
 * propósito — es lo que hace imposible que un aviso interno termine en el grupo de un cliente.
 *
 *   (A) Cuando alguien dice que pagó. Antes el aviso quedaba esperando en «Pendientes» y ella se
 *       enteraba sólo si entraba a mirar.
 *   (B) Una vez por día, qué cuentas quedaron cobradas y sin mandar. NO las manda: le avisa a ella
 *       y ella aprieta. Fue su decisión, textual: "que te avise a vos primero, y vos apretás".
 *
 * ── EL BOT ES EL GENERAL, NO EL DEL CHAT ─────────────────────────────────────────────────────
 * Los otros mensajes internos que existen salen con `getTelegramToken()` + `getApiGrupoMatriz()`, y
 * ésa es la única prueba de que ese bot está adentro de ese grupo. `chat.botToken()` cae al general
 * cuando el propio está vacío: el día que ella pegue un bot propio del chat, un aviso interno que
 * usara esa función cambiaría de bot solo hacia uno que nadie agregó a la matriz. Y Telegram
 * contesta eso con un `{ok:false}`, no con una excepción: fallaría en silencio para siempre.
 */
const telegram = require('./telegram');
const cfg = require('./config-store');
const chat = require('./chat-externo.store');
const { fechaTZ, horaNum, TZ } = require('./lib/fechas');

/* La referencia la escribe el cliente en un formulario público. Un `<` suelto rompe el mensaje
   entero cuando Telegram lo parsea como HTML, y el aviso no llega: se escapa todo lo que venga de
   afuera. */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* El interruptor. Existe porque el suite hace POST de verdad contra /chat/aviso y sin esto cada
   check mandaría un mensaje al grupo de la matriz. Se prende en test/smoke.js y en el taller. */
const APAGADO = () => String(process.env.CHAT_AVISOS_OFF || '') === '1';

const MES_LARGO = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/* SIEMPRE «agosto 2026», nunca «2026-08» ni «agosto» pelado. Dos formas de escribir el mismo mes
   en dos pantallas es exactamente lo que hace que nadie note que son meses distintos. */
const mesLindo = (m) => {
  const [a, x] = String(m || '').split('-');
  return `${MES_LARGO[Number(x)] || m} ${a || ''}`.trim();
};

function _matriz() { return { tok: cfg.getTelegramToken(), grupo: cfg.getApiGrupoMatriz() }; }
/* El dominio no se deduce nunca: si no está cargado, el mensaje va sin link en vez de con uno
   inventado. */
const _base = () => cfg.getUrlPublica();

async function _mandar(texto) {
  if (APAGADO()) return { ok: false, error: 'avisos apagados (CHAT_AVISOS_OFF)' };
  const { tok, grupo } = _matriz();
  if (!tok) return { ok: false, error: 'falta el token del bot (⚙ Config → Telegram)' };
  if (!grupo) return { ok: false, error: 'falta el grupo de la matriz (⚙ Config → Telegram)' };
  try {
    const r = await telegram.sendMessage(tok, grupo, texto);
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'Telegram no dijo por qué' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/* ── (A) DICEN QUE PAGARON ───────────────────────────────────────────────────────────────── */

const DE_QUE = {
  ganancia: '<b>el servicio del mes</b>',
  mantenimiento: '<b>el mantenimiento</b>',
};

/* El texto va aparte del envío para poder probarlo sin mandar nada.
   Devuelve null cuando NO hay que mandar: del cuarto aviso sin resolver en adelante se calla, y el
   tercero ya avisó que se están juntando. Un cliente apretando el botón no puede convertirse en
   una ráfaga de mensajes. */
function textoAvisoPago(a) {
  if (!a) return null;
  const link = _base() ? `\n\n${_base()}/chat-externo` : '';
  if (a.sinResolver >= 4) return null;
  if (a.sinResolver === 3) {
    return '💬 <b>Chat Externo</b>\n\n'
      + `<b>${esc(a.cliente)}</b> ya tiene <b>${a.sinResolver}</b> avisos de pago sin resolver.\n`
      + `El último: <b>${esc(a.monto)} ${esc(a.moneda)}</b>.\n\n`
      + `Mientras no los resuelvas no te aviso los que sigan.${link}`;
  }
  return '💬 <b>Chat Externo · dicen que pagaron</b>\n\n'
    + `Cliente: <b>${esc(a.cliente)}</b>\n`
    + `Monto: <b>${esc(a.monto)} ${esc(a.moneda)}</b>\n`
    + `Es de: ${DE_QUE[a.concepto] || '<i>no lo dijo</i>'}\n`
    /* De cuál de sus cuentas. Con dos, aprobarlo contra la equivocada deja las dos mal, y desde
       el aviso es donde se ve antes de tocar nada. */
    + (a.divisa ? `Cuenta: <b>sus cajas en ${esc(a.divisa)}</b>\n` : '')
    + `Mes: ${esc(mesLindo(a.mes))}\n`
    + `Referencia: ${a.referencia ? `<code>${esc(a.referencia)}</code>` : '<i>no puso</i>'}\n`
    + (a.archivo_bytes ? '📎 Adjuntó comprobante' : '⚠️ SIN comprobante')
    + `\n\nQueda <b>pendiente</b> hasta que lo apruebes vos.${link}`;
}

/**
 * Avisa de UN pago. Se le pasa el id y relee la fila: así el mensaje dice lo mismo venga del portal
 * o de la hoja con token, y lo compone el servidor con la base.
 *
 * ⚠️ SIEMPRE deja anotado el resultado, incluso cuando está apagado o falta configuración. Que
 * falte el grupo no es "no había que avisar": es un aviso que no salió, y eso tiene que poder verse
 * en la pantalla. Nunca tira: lo llama una ruta que ya le contestó al cliente.
 */
async function avisarPago(id) {
  try {
    const a = chat.avisoPorId(id);
    if (!a) return { ok: false, error: 'ese aviso ya no está' };
    const txt = textoAvisoPago(a);
    if (txt === null) {                       // plegado a propósito: no es una falla
      chat.marcarAvisoPago(id, { ok: true, error: null });
      return { ok: true, plegado: true };
    }
    const r = await _mandar(txt);
    chat.marcarAvisoPago(id, r);
    return r;
  } catch (e) {
    try { chat.marcarAvisoPago(id, { ok: false, error: String((e && e.message) || e) }); } catch (e2) { /* ya está */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ── AL PROVEEDOR: LE AVISAMOS CUANDO SE LE PAGA ─────────────────────────────────────────── */

/**
 * ⚠️ ESTE ES EL ÚNICO MENSAJE DE ESTE ARCHIVO QUE SALE PARA AFUERA, y va a un grupo distinto: el
 * del proveedor, no el de la matriz. Por eso el destino se pide explícito y no se reusa `_mandar`,
 * que apunta a la matriz — un descuido ahí le mandaría a él lo que es para adentro.
 *
 * Lleva el CONCEPTO y el DESTINO. «Te pagué 1.050» sin decir de qué es ni adónde fue obliga a
 * preguntar las dos cosas, que es la conversación que este aviso existe para evitar.
 */
function textoPagoAlProveedor(pago) {
  if (!pago) return null;
  const conc = pago.concepto === 'mantenimiento' ? 'el <b>mantenimiento</b>' : 'la <b>ganancia</b>';
  const L = ['💸 <b>Te pagamos</b>', ''];
  L.push(`Monto: <b>${esc(pago.monto)} ${esc(pago.moneda || 'USDT')}</b>`);
  L.push(`Es por: ${conc} de <b>${esc(mesLindo(pago.mes))}</b>`);
  L.push(`Fecha: ${esc(pago.fecha)}`);
  if (pago.destino) {
    L.push(`A: <code>${esc(pago.destino)}</code>${pago.red ? ` · ${esc(pago.red)}` : ''}`);
  }
  if (pago.hash) L.push(`Hash: <code>${esc(pago.hash)}</code>`);
  if (pago.nota_prov) { L.push(''); L.push(esc(pago.nota_prov)); }
  const b = _base();
  if (b) { L.push(''); L.push(`Tu liquidación: ${b}/proveedor`); }
  return L.join('\n');
}

/* ── EL MANTENIMIENTO LO COBRA ÉL, ASÍ QUE TIENE QUE ENTERARSE ───────────────────────────────
 * Las wallets del mantenimiento son suyas: el cliente le transfiere directo y a él le entra plata
 * sin saber de qué caja ni de qué período es. Cuando ella aprueba el aviso, se lo reenvía con el
 * comprobante y con las dos cosas que necesita para imputarlo: QUÉ CAJA y QUÉ PERÍODO.
 *
 * ⚠️ Va con el bot y el grupo DEL PROVEEDOR, igual que el aviso de pago. No se reusa `_mandar`,
 * que apunta a la matriz: un descuido ahí le mandaría a él lo que es de adentro.
 */
function textoMantenimientoCobrado(a, cajas) {
  if (!a) return null;
  const L = ['💰 <b>Te pagaron el mantenimiento</b>', ''];
  if (cajas && cajas.length) {
    for (const c of cajas) {
      L.push(`· <b>${esc(c.caja)}</b>${c.periodo ? ` — ${esc(c.periodo)}` : ''}`);
    }
    L.push('');
  }
  L.push(`Monto: <b>${esc(a.monto)} ${esc(a.moneda || 'USDT')}</b>`);
  L.push(`Mes: ${esc(mesLindo(a.mes))}`);
  if (a.referencia) L.push(`Referencia: <code>${esc(a.referencia)}</code>`);
  L.push('');
  L.push('Te lo transfirió el cliente directo a tu wallet. Va el comprobante.');
  return L.join('\n');
}

/** Le reenvía el comprobante del mantenimiento. Nunca tira: lo llama una ruta que ya aprobó. */
async function avisarMantenimientoCobrado(aviso, cajas, archivos) {
  try {
    if (APAGADO()) return { ok: false, error: 'avisos apagados (CHAT_AVISOS_OFF)' };
    const grupo = chat.proveedorGrupo();
    if (!grupo) return { ok: false, error: 'el proveedor no tiene grupo de Telegram cargado' };
    const tok = chat.botToken();
    if (!tok) return { ok: false, error: 'falta el token del bot' };
    const texto = textoMantenimientoCobrado(aviso, cajas);
    /* Con comprobante va como foto y con el texto de pie; sin comprobante, el texto solo. Lo
       segundo pasa: el cliente puede avisar sin subir nada. */
    const arch = (archivos || [])[0];
    let r;
    if (arch && arch.archivo_b64) {
      r = await telegram.sendArchivo(tok, grupo, {
        archivo: Buffer.from(arch.archivo_b64, 'base64'),
        nombre: arch.archivo_nombre || 'comprobante',
        mime: arch.archivo_tipo || 'application/octet-stream',
        caption: texto,
      });
      // Los que sobran van detrás, sin repetir el texto: son la misma transferencia partida.
      for (const x of (archivos || []).slice(1)) {
        if (!x || !x.archivo_b64) continue;
        // eslint-disable-next-line no-await-in-loop
        await telegram.sendArchivo(tok, grupo, {
          archivo: Buffer.from(x.archivo_b64, 'base64'),
          nombre: x.archivo_nombre || 'comprobante',
          mime: x.archivo_tipo || 'application/octet-stream',
          caption: '',
        });
      }
    } else {
      r = await telegram.sendMessage(tok, grupo, texto);
    }
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'Telegram no dijo por qué' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** Manda ese aviso al grupo DEL PROVEEDOR. Nunca tira: lo llama una ruta que ya registró el pago. */
async function avisarPagoAlProveedor(pago) {
  try {
    if (APAGADO()) return { ok: false, error: 'avisos apagados (CHAT_AVISOS_OFF)' };
    const grupo = chat.proveedorGrupo();
    if (!grupo) return { ok: false, error: 'el proveedor no tiene grupo de Telegram cargado' };
    /* El bot DEL CHAT, no el general: este grupo es de este servicio y es el bot que ella agrega
       ahí. `botToken()` cae al general si no hay uno propio, que es el comportamiento correcto
       mientras no lo haya. */
    const tok = chat.botToken();
    if (!tok) return { ok: false, error: 'falta el token del bot' };
    const txt = textoPagoAlProveedor(pago);
    if (!txt) return { ok: false, error: 'no hay qué mandar' };
    const r = await telegram.sendMessage(tok, grupo, txt);
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'Telegram no dijo por qué' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/* ── (B) LO QUE TE FALTA MANDAR ──────────────────────────────────────────────────────────── */

/**
 * ⚠️ LOS RENGLONES NO LLEVAN MONTO, Y ES A PROPÓSITO.
 * Lo que se congela al cobrar y lo que la pantalla muestra en vivo se separan solos: el acumulado
 * se sana todas las noches, y un tipo de cambio o un % que se toca mueve el vivo. Un número en
 * Telegram que no coincide con el de la pantalla, en un canal donde no se puede preguntar cuál es
 * el bueno, es peor que no poner ninguno. Con el nombre y el mes alcanza para saber a quién entrar.
 */
function textoFaltaMandar(listas) {
  const mandar = (listas && listas.mandar) || [];
  const sinGrupo = (listas && listas.sinGrupo) || [];
  const faltaCobrar = (listas && listas.faltaCobrar) || [];
  if (!mandar.length && !sinGrupo.length && !faltaCobrar.length) return null;   // silencio

  /* ⚠️ SI LO QUE FALTA ES COBRAR, NO SE DICE «MANDÁ». Son dos pasos y éste es el primero: mandar
     la cuenta antes de cobrar el mes le manda al cliente un número calculado en vivo, que no es el
     que se le va a cobrar. Decirle «mandá» acá la manda a hacer el segundo paso sin el primero. */
  if (faltaCobrar.length && !mandar.length) {
    const meses = [...new Set(faltaCobrar.map((x) => mesLindo(x.mes)))];
    const L2 = ['💬 <b>Chat Externo · te falta cobrar el mes</b>', ''];
    L2.push(meses.length === 1
      ? `<b>${esc(meses[0])}</b> todavía no está cobrado.`
      : `Todavía no cobraste: <b>${meses.map(esc).join(', ')}</b>.`);
    L2.push('');
    L2.push(`Son <b>${faltaCobrar.length}</b> cuenta${faltaCobrar.length === 1 ? '' : 's'}: `
      + faltaCobrar.slice(0, 10).map((x) => esc(x.cliente)).join(', ')
      + (faltaCobrar.length > 10 ? `, y ${faltaCobrar.length - 10} más` : '') + '.');
    L2.push('');
    L2.push('Hasta que lo cobres, el número se sigue moviendo. Después de cobrar se las mandás.');
    const m0 = (faltaCobrar[0] || {}).mes || '';
    if (_base()) L2.push(`${_base()}/chat-externo${m0 ? `?mes=${m0}` : ''}`);
    return L2.join('\n');
  }

  const L = ['💬 <b>Chat Externo · te falta mandar</b>', ''];
  if (mandar.length) {
    L.push(mandar.length === 1
      ? 'Hay <b>1</b> cuenta cobrada que todavía no mandaste:'
      : `Hay <b>${mandar.length}</b> cuentas cobradas que todavía no mandaste:`);
    L.push('');
    // Tope de 10 renglones: más largo se parte en dos mensajes y se lee peor que un resumen.
    mandar.slice(0, 10).forEach((x) => L.push(`• <b>${esc(x.cliente)}</b> · ${esc(mesLindo(x.mes))}`
      + (x.fallo ? ' · ✕ el intento anterior no salió' : '')));
    if (mandar.length > 10) L.push(`…y ${mandar.length - 10} más.`);
  }
  /* La lista de los que no tienen grupo sale SOLA, sin depender de que haya alguna mandable. Si
     dependiera, el día que ninguna tenga grupo —que es como arranca todo— no saldría nada y una
     cuenta cobrada podía quedarse un mes sin mandar sin una sola señal. */
  if (sinGrupo.length) {
    if (mandar.length) L.push('');
    L.push(sinGrupo.length === 1
      ? `⚠️ <b>${esc(sinGrupo[0].cliente)}</b> está cobrado y no tiene grupo de Telegram cargado.`
      : `⚠️ <b>${sinGrupo.length}</b> están cobrados y no tienen grupo de Telegram cargado: `
        + sinGrupo.slice(0, 8).map((x) => esc(x.cliente)).join(', ')
        + (sinGrupo.length > 8 ? `, y ${sinGrupo.length - 8} más` : '') + '.');
  }
  L.push('');
  L.push(mandar.length
    ? 'Entrá y apretá <b>Enviársela</b> en cada una:'
    : 'Cargales el grupo en <b>Cajas y clientes</b>:');
  /* El link lleva EL MES del primero de la lista. Sin eso, del día 11 en adelante la pantalla abre
     el mes corriente sola, y apretar Enviar mandaría la cuenta de un mes que todavía no cerró. */
  const mes = (mandar[0] || sinGrupo[0] || {}).mes || '';
  if (_base()) L.push(`${_base()}/chat-externo${mes ? `?mes=${mes}` : ''}`);
  return L.join('\n');
}

/** El recordatorio. Devuelve qué pasó, para que el cron sepa si marcar el día como hecho. */
async function recordarLoQueFalta() {
  const listas = chat.listasParaMandar();
  const txt = textoFaltaMandar(listas);
  if (txt === null) return { ok: true, nadaQueMandar: true };
  const r = await _mandar(txt);
  return { ...r, cuentas: (listas.mandar || []).length, sinGrupo: (listas.sinGrupo || []).length,
    faltaCobrar: (listas.faltaCobrar || []).length };
}

/**
 * Los avisos de pago que no llegaron a la matriz, reintentados.
 * Sin esto, (A) tiene UNA sola chance: si Telegram estaba caído en ese segundo, el aviso se pierde
 * y la única red es una pantalla que ella justamente dijo que no mira.
 */
async function reintentarAvisos() {
  const pend = chat.avisosSinNotificar();
  let salieron = 0;
  for (const a of pend) {
    // eslint-disable-next-line no-await-in-loop
    const r = await avisarPago(a.id);
    if (r && r.ok) salieron += 1;
  }
  return { ok: true, reintentados: pend.length, salieron };
}

/* ── EL CRON ─────────────────────────────────────────────────────────────────────────────── */

const CLAVE_DIA = 'chatRecordatorioUltimo';

/**
 * Una vez por día, a la hora H.
 *
 * ⚠️ EL "YA AVISÉ HOY" VIVE EN LA BASE, NO EN UNA VARIABLE.
 * Railway reinicia el proceso en cada deploy. Con la marca en memoria, un deploy hecho dentro de la
 * hora del cron la borra y el recordatorio sale de nuevo. Ese error ya pasó en este repo con los
 * snapshots de tipo de cambio y quedó documentado; no hay por qué repetirlo.
 *
 * El día se marca hecho sólo si el mensaje salió, o si no había nada que mandar. Si Telegram falló,
 * el próximo tick de la misma hora reintenta: hay doce.
 */
function startCron() {
  if (APAGADO()) { console.log('[ChatAvisos] apagado por CHAT_AVISOS_OFF'); return; }
  const H = Number(process.env.CHAT_AVISOS_HORA || '10');
  setInterval(async () => {
    try {
      if (horaNum() !== H) return;
      const hoy = fechaTZ();                       // el día de ELLA, no el UTC
      if (cfg.getCfg(CLAVE_DIA) === hoy) return;
      // Primero los avisos que quedaron sin salir: son de plata que ya entró.
      const re = await reintentarAvisos();
      if (re.salieron) console.log(`[ChatAvisos] ${re.salieron} aviso(s) de pago reintentados con éxito`);
      const r = await recordarLoQueFalta();
      if (r.nadaQueMandar) {
        cfg.setCfg(CLAVE_DIA, hoy);
        console.log('[ChatAvisos] recordatorio: no hay cuentas cobradas sin mandar (silencio)');
        return;
      }
      if (r.ok) {
        cfg.setCfg(CLAVE_DIA, hoy);
        console.log(`[ChatAvisos] recordatorio: ${r.cuentas} para mandar, ${r.sinGrupo} sin grupo`);
      } else {
        console.warn('[ChatAvisos] el recordatorio no salió, se reintenta en el próximo tick:', r.error);
      }
    } catch (e) { console.warn('[ChatAvisos] cron error:', e.message); }
  }, 5 * 60 * 1000);
  console.log(`[ChatAvisos] recordatorio diario a las ${H}:00 ${TZ}`);
}

module.exports = {
  textoMantenimientoCobrado, avisarMantenimientoCobrado,
  avisarPago, textoAvisoPago,
  avisarPagoAlProveedor, textoPagoAlProveedor,
  recordarLoQueFalta, textoFaltaMandar,
  reintentarAvisos, startCron, mesLindo,
};
