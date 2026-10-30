/* Los pendientes del panel llegan solos (30-oct-2026): el servidor manda los tres números por una
   conexión abierta cuando cambian, en vez de que el panel pregunte cada 45 segundos. */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'avisos-')), 'a.sqlite');
const { EventEmitter } = require('events');
const avisos = require('../src/lib/avisos-panel');
const solicitudes = require('../src/solicitudes-caja');
const comprobantes = require('../src/comprobantes-store');
const clientes = require('../src/clientes-store');

let ok = 0; let fail = 0;
const check = (t, c, x) => { if (c) { ok++; console.log('✅ ' + t); } else { fail++; console.log('❌ ' + t + (x ? '  → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Un panel conectado de mentira: guarda lo que el servidor le escribe.
function panel() {
  const req = new EventEmitter(); const res = { escrito: '', cabeceras: null,
    writeHead(c, h) { this.cabeceras = h; }, write(x) { this.escrito += x; } };
  avisos.conectar(req, res);
  res.eventos = () => res.escrito.split('\n\n').filter((b) => /^event: pendientes/.test(b))
    .map((b) => JSON.parse(b.split('data: ')[1]));
  return { req, res };
}

(async () => {
  const a = panel();
  check('es una conexión de eventos que el proxy no guarda', /text\/event-stream/.test(a.res.cabeceras['Content-Type'])
    && a.res.cabeceras['X-Accel-Buffering'] === 'no');
  check('al conectarse recibe los números enseguida', a.res.eventos().length === 1
    && JSON.stringify(a.res.eventos()[0]) === JSON.stringify({ comprobantes: 0, cajas: 0, movs: 0 }), JSON.stringify(a.res.eventos()));

  const cli = clientes.createCliente({ codigo: 'AVISO1', nombreVisible: 'Prueba Avisos', nombre: 'Prueba Avisos' });
  const cliId = (cli && (cli.cliente || cli).id) || (clientes.getByCodigo('AVISO1') || {}).id;
  const s = solicitudes.crear({ cliente_id: cliId, sistema: 'Casino', nodo: '123', login: 'cajaprueba' }, 'test');
  check('se pudo pedir una caja de prueba', s && s.ok, s && s.error);
  await sleep(450);
  const ult = a.res.eventos().slice(-1)[0];
  check('pedir una caja avisa en el acto (sin esperar 45 s)', ult && ult.cajas === 1, JSON.stringify(ult));

  const c = comprobantes.crear({ codigo: 'AVISO1', clienteNombre: 'Prueba', via: 'usdt', monto: '50', divisa: 'USDT' });
  await sleep(450);
  check('un comprobante nuevo avisa en el acto', a.res.eventos().slice(-1)[0].comprobantes === 1, JSON.stringify(a.res.eventos().slice(-1)[0]));
  comprobantes.resolver(c.comprobante.id, { estado: 'rechazado', por: 'test', motivo: 'prueba' });
  await sleep(450);
  check('y resolverlo también', a.res.eventos().slice(-1)[0].comprobantes === 0);

  const antes = a.res.eventos().length;
  avisos.cambio(); await sleep(450);
  check('si no cambió nada, no viaja nada', a.res.eventos().length === antes);

  const b = panel();
  check('un segundo panel abierto recibe lo mismo al entrar', JSON.stringify(b.res.eventos()[0]) === JSON.stringify(a.res.eventos().slice(-1)[0]));
  a.req.emit('close'); b.req.emit('close');
  check('al cerrar los paneles se suelta todo (el recuento interno se apaga)', avisos._conectados() === 0);

  console.log(`\n${ok} chequeos OK, ${fail} fallaron\n`); process.exit(fail ? 1 : 0);
})();
