/**
 * cuenta-espejo.js — LA CAJA Y EL PANEL SON LA MISMA CUENTA DEL CASINO.
 *
 * Cada login del casino está anotado dos veces: como CAJA (dentro del cliente, la usan Mi Caja, los
 * pedidos y los permisos) y como PANEL (la tabla paneles, la usan la factura, la Foto y externos).
 * Hasta el 22-oct-2026 había dos copiadores, uno para cada lado, y copiaban campos distintos: de la
 * caja al panel no pasaba el `usuario`, así que renombrar una caja y después tocar el panel le
 * devolvía a la caja el nombre viejo. Y mover un panel a otro cliente creaba una caja nueva y dejaba
 * la vieja en el cliente anterior.
 *
 * Acá está la única regla:
 *  · La identidad de una cuenta es (sistema, id del usuario en el casino). El nombre no: hay
 *    clientes con dos cuentas que se llaman igual (CARLOS777 tiene dos «Betpalace-SA»).
 *  · Los campos compartidos son el login y las monedas. En la caja el login es `usuario`; en el
 *    panel, `usuario` y `nombre` (que siempre llevan lo mismo).
 *  · Una cuenta de DISTRIBUIDOR (caja con rol 'distribuidor') no es un panel a propósito: su
 *    consumo ya incluye el de sus agentes, facturarlo junto a ellos sería cobrar dos veces.
 */
const clientes = require('./clientes-store');
const paneles = require('./paneles-store');

const mismaCuenta = (sa, ia, sb, ib) => !!ia && String(ia) === String(ib) && (sa || '') === (sb || '');
const loginDePanel = (p) => (p && (p.usuario || p.nombre)) || '';
const mismasDivisas = (a, b) => (a || []).slice().sort().join(',') === (b || []).slice().sort().join(',');

/** De la caja al panel (cuando se crea o se edita una caja). */
function cajaAPanel(clienteId, caja) {
  if (!caja || !caja.userId || caja.rol === 'distribuidor') return null;
  const p = paneles.list({ cliente_id: clienteId }).find((x) => mismaCuenta(x.sistema, x.id_usuario, caja.sistema, caja.userId));
  if (p) {
    const login = caja.usuario || loginDePanel(p);
    if (mismasDivisas(p.divisas, caja.divisas) && p.nombre === login && p.usuario === login) return 'sin cambios';
    paneles.update(p.id, { nombre: login, usuario: login, divisas: caja.divisas });
    return 'actualizado';
  }
  const nuevo = paneles.create({ cliente_id: clienteId, nombre: caja.usuario, usuario: caja.usuario,
    sistema: caja.sistema, id_usuario: caja.userId, divisas: caja.divisas });
  /* ⚠️ Y SE LE RESUELVE EL ÁRBOL, igual que cuando el panel se crea desde el OS. Sin esto el panel
     nace sin padres, la carga va directo al nodo y el casino la rechaza con "Suma de entrada excede
     los límites". 27-sep-2026: NahuelBet30 y NahuelZeus salieron los dos por acá. Corre en segundo
     plano y tarda cerca de un minuto. */
  require('./arbol.service').resolverEnSegundoPlano(nuevo);
  return 'creado';
}

/**
 * Del panel a la caja (cuando se crea, se edita o se mueve un panel).
 * `desde`: el cliente que tenía el panel antes de guardarlo. Si cambió, la caja se MUDA con todo lo
 * suyo (permisos, nombre para el cliente, montos rápidos, el mismo id) en vez de nacer una nueva.
 * @returns false (sin cambios) | 'actualizada' | 'movida' | true (creada)
 */
function panelACaja(p, { destino, desde } = {}) {
  if (!p || !p.id_usuario) return false;
  const a = destino || p.cliente_id;
  if (!a) return false;
  const login = loginDePanel(p);
  const esta = (c) => (c && (c.cajas || []).find((k) => mismaCuenta(k.sistema, k.userId, p.sistema, p.id_usuario))) || null;

  if (desde && desde !== a) {
    const viejo = clientes.get(desde); const k = esta(viejo);
    /* La caja se queda donde está si el cliente viejo tiene OTRO panel de esa cuenta, o si el nuevo
       ya tiene su caja: las dos son cuentas compartidas (Marcelo y JJ) y el viejo sigue pidiendo. */
    const otro = paneles.list({ cliente_id: desde }).some((x) => x.id !== p.id && mismaCuenta(x.sistema, x.id_usuario, p.sistema, p.id_usuario));
    if (k && !otro && !esta(clientes.get(a))) {
      clientes.moverCaja(desde, a, k.id);
      panelACaja(p, { destino: a });
      return 'movida';
    }
  }

  const c = clientes.get(a); if (!c) return false;
  const ya = esta(c);
  if (ya) {
    if (mismasDivisas(ya.divisas, p.divisas) && String(ya.usuario || '') === String(login)) return false;
    clientes.updateCaja(a, ya.id, { usuario: login, divisas: p.divisas });
    return 'actualizada';
  }
  clientes.addCaja(a, { usuario: login, sistema: p.sistema, userId: p.id_usuario, divisas: p.divisas, montosRapidos: [], grupoId: '' });
  return true;
}

/**
 * LO QUE NO CUADRA ENTRE CAJAS Y PANELES, comparando por cuenta del casino (no por nombre).
 *  · sinPanel: cajas cuya cuenta no tiene panel en ningún cliente → lo que mueven no se le factura
 *    a nadie. Las de distribuidor no cuentan.
 *  · enOtroCliente: la caja está en un cliente y el panel en otro que NO tiene esa caja (lo que
 *    quedaba al mover un panel). Si el del panel también tiene la caja, es una cuenta compartida a
 *    propósito (Marcelo y JJ) y está bien.
 *  · sinCaja: paneles cuya cuenta no tiene caja → esa cuenta no puede pedir por Mi Caja.
 *  · distintas: misma cuenta y mismo cliente, con otro login u otras monedas.
 *  · sinId: cajas sin id del casino, que no se pueden cruzar con nada.
 */
function diferencias() {
  const cs = clientes.list().clientes;
  const ps = paneles.list();
  const nom = (id) => { const c = cs.find((x) => x.id === id); return c ? (c.nombre || c.codigo) : id; };
  const out = { sinPanel: [], enOtroCliente: [], sinCaja: [], distintas: [], sinId: [] };
  const cajasDe = (s, u) => cs.filter((c) => (c.cajas || []).some((k) => mismaCuenta(k.sistema, k.userId, s, u)));
  for (const c of cs) {
    for (const k of (c.cajas || [])) {
      if (k.rol === 'distribuidor') continue;
      if (!k.userId) { out.sinId.push({ cliente: nom(c.id), usuario: k.usuario }); continue; }
      const deLaCuenta = ps.filter((p) => mismaCuenta(p.sistema, p.id_usuario, k.sistema, k.userId));
      const propio = deLaCuenta.find((p) => p.cliente_id === c.id);
      const fila = { cliente: nom(c.id), usuario: k.usuario, sistema: k.sistema, id: String(k.userId) };
      if (!deLaCuenta.length) { out.sinPanel.push(fila); continue; }
      if (!propio) {
        const compartida = deLaCuenta.some((p) => cajasDe(k.sistema, k.userId).some((x) => x.id === p.cliente_id));
        if (!compartida) out.enOtroCliente.push({ ...fila, panelEn: deLaCuenta.map((p) => nom(p.cliente_id)).join(', ') });
        continue;
      }
      const login = loginDePanel(propio);
      if (String(login) !== String(k.usuario || '') || !mismasDivisas(propio.divisas, k.divisas)) {
        out.distintas.push({ ...fila, panel: login, divisasCaja: (k.divisas || []).join(','), divisasPanel: (propio.divisas || []).join(',') });
      }
    }
  }
  for (const p of ps) {
    if (!p.id_usuario) continue;
    if (!cajasDe(p.sistema, p.id_usuario).length) out.sinCaja.push({ cliente: nom(p.cliente_id), usuario: loginDePanel(p), sistema: p.sistema, id: String(p.id_usuario) });
  }
  return out;
}

module.exports = { cajaAPanel, panelACaja, diferencias, mismaCuenta, loginDePanel };
