/* ══════ UN CASINO DE MENTIRA, PARA PODER PROBAR SIN MOVER PLATA ══════

   Mi Caja habla con el motor de Ganamos por HTTP. Probarla contra el casino de verdad significa
   mover fichas de verdad en cada corrida, así que no se puede. Esto imita al motor: las mismas
   direcciones, los mismos nombres de campo y las mismas rarezas que están medidas y anotadas en
   `caja.routes.js`.

   Además GUARDA CADA PEDIDO que recibe. Eso es la mitad del valor: la familia de errores que más
   dolió en este sistema —filtros que el motor hereda de la llamada anterior— no se ve mirando la
   respuesta, se ve mirando QUÉ SE MANDÓ. Con esto un test puede exigir que toda consulta de
   cuentas lleve sus filtros, y no depender de que alguien se acuerde.

   Lo que imita, medido contra el casino el 1-sep-2026:
     · el login de dos pasos (GET que da la cookie, POST que redirige)
     · `info`, `users` con paginado, `balance`, `buttons`
     · «retirar todo» NO hace nada sobre una caja, y sí sobre un jugador                          */

const http = require('http');
const { URL, URLSearchParams } = require('url');

function crearMotorFalso() {
  /* El estado: cuentas con su saldo. `padre` arma el árbol. */
  const cuentas = new Map();
  const pedidos = [];

  const poner = (c) => {
    cuentas.set(String(c.id), {
      id: String(c.id), login: c.login, group: String(c.group),
      padre: c.padre == null ? null : String(c.padre),
      saldo: Number(c.saldo) || 0, borrada: !!c.borrada,
      permisos: c.permisos || {},
    });
  };

  /* Un mundo mínimo pero real: un agente, su caja y dos jugadores. */
  poner({ id: '100', login: 'AgenteDePrueba', group: 3, padre: null, saldo: 50000 });
  poner({ id: '200', login: 'CajaDePrueba', group: 4, padre: '100', saldo: 8000 });
  poner({ id: '301', login: 'JugadorUno', group: 5, padre: '200', saldo: 500 });
  poner({ id: '302', login: 'JugadorDos', group: 5, padre: '200', saldo: 0 });
  /* Un sub-cajero con el saldo de la caja escondido: sirve para verificar que ese permiso se LEE
     del motor y no se supone. La maqueta lo traía escrito a mano en `true` para todos. */
  poner({ id: '801', login: 'SubCajaDePrueba', group: 8, padre: '200', saldo: 0,
    permisos: { hide_hall_balance: '1', disable_statistic: '0' } });
  /* Un sub-agente: cuelga del agente y ve sus cajas. Al motor de verdad, este nivel le pide el
     resumen y recibe TODO EN CERO — se imita, porque de ahí sale la única forma honesta de
     mostrarlo: calcular lo que se pueda y decir lo que no. */
  poner({ id: '601', login: 'SubAgenteDePrueba', group: 6, padre: '100', saldo: 0 });

  const hijosDe = (id) => [...cuentas.values()].filter((c) => c.padre === String(id));

  const comoFila = (c) => ({
    id: c.id, login: c.login, name: '', group: c.group,
    balances: { ARS: String(c.saldo) },
    /* Cuántos jugadores tiene esa caja. Es el dato con el que se arma el resumen de un
       sub-agente cuando el casino no se lo calcula. */
    terminals: { ARS: String(hijosDe(c.id).length) },
    terminals_online: { ARS: '0' },
    deleted: c.borrada ? '1' : '0',
  });

  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');

    /* Dos puertas de servicio para los tests: mirar lo que se pidió, y volver a empezar. */
    if (u.pathname === '/__pedidos') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(pedidos));
    }
    if (u.pathname === '/__estado') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([...cuentas.values()]));
    }
    if (u.pathname === '/__reiniciar') {
      pedidos.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }

    let crudo = '';
    req.on('data', (d) => { crudo += d; });
    req.on('end', () => {
      const area = u.searchParams.get('area') || '';
      const query = Object.fromEntries(u.searchParams.entries());
      const cuerpo = Object.fromEntries(new URLSearchParams(crudo).entries());

      /* ── el login de dos pasos ── */
      if (area === 'login') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Set-Cookie': 'PHPSESSID=mentira123; path=/' });
          return res.end('<html>login</html>');
        }
        const quien = [...cuentas.values()].find((c) => c.login === cuerpo.login);
        if (!quien || cuerpo.password !== 'clave-de-prueba') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html>area=login otra vez</html>');
        }
        res.writeHead(302, {
          'Set-Cookie': `PHPSESSID=sesion-de-${quien.id}; path=/`,
          Location: '/index.php?act=admin&area=main',
        });
        return res.end();
      }

      /* De acá en adelante todo es la API con respuesta JSON. Se anota ANTES de contestar. */
      pedidos.push({ area, query, cuerpo, cookie: req.headers.cookie || '' });

      const quienSoy = () => {
        /* Con `api_token` se entra como la credencial RAÍZ, que en el casino de verdad es la que
           puede leer la ficha de cualquiera. Sin ella, cada cuenta sólo puede lo suyo — y eso es
           justo lo que hace falta imitar para que los tests exijan usar la raíz donde corresponde. */
        if (cuerpo.api_token) return { id: 'RAIZ', login: 'raiz', group: '1', esRaiz: true };
        const m = /sesion-de-(\d+)/.exec(req.headers.cookie || '');
        return m ? cuentas.get(m[1]) : null;
      };
      const responder = (datos) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(datos));
      };

      const yo = quienSoy();
      if (!yo) return responder({ redirect: 'login' });

      if (area === 'info') {
        if (yo.esRaiz) return responder({ main: { id: 'RAIZ', login: 'raiz', group: '1' } });
        return responder({
          main: { id: yo.id, login: yo.login, group: yo.group, balance: yo.saldo, currency: 'ARS' },
          editUser: { id: yo.id, login: yo.login },
        });
      }

      if (area === 'buttons') {
        const porGrupo = {
          3: ['users', 'useredit', 'balance', 'createuser', 'sub', 'reports', 'dashboard', 'usersettings', 'intersections'],
          4: ['users', 'useredit', 'balance', 'createuser', 'reports'],
          6: ['users', 'useredit', 'balance', 'createuser', 'reports', 'dashboard'],
          8: ['users', 'useredit', 'balance', 'createuser', 'reports'],
        };
        return responder({ buttons: (porGrupo[yo.group] || []).map((n) => ({ name: n })) });
      }

      if (area === 'users') {
        /* El paginado del motor: `offset` es la PÁGINA, empezando en 1. */
        const pagina = Math.max(1, Number(query.offset) || 1);
        const porPagina = Math.max(1, Number(cuerpo.limit) || 200);
        /* 🔴 UN SUB-AGENTE PIDIENDO SU PROPIO NODO RECIBE LAS CAJAS DE SU AGENTE. Medido contra
           el casino el 2-sep-2026: entrando con un sub-agente, `users` sobre su propio id devolvió
           la caja que tiene habilitada, no una lista vacía. El motor resuelve el alcance solo. */
        const dueño = (yo.group === '6' && String(query.id) === String(yo.id) && yo.padre)
          ? yo.padre : query.id;
        let filas = hijosDe(dueño);
        /* El filtro de borradas: el motor devuelve unas u otras, nunca las dos. */
        filas = filas.filter((c) => (cuerpo.deleted_users === 'delete' ? c.borrada : !c.borrada));
        if (cuerpo.search) filas = filas.filter((c) => c.login.includes(cuerpo.search));
        const desde = (pagina - 1) * porPagina;
        return responder({
          users: filas.slice(desde, desde + porPagina).map(comoFila),
          pageCount: Math.max(1, Math.ceil(filas.length / porPagina)),
        });
      }

      if (area === 'balance') {
        const destino = cuentas.get(String(query.id));
        if (!destino) return responder({ error: 'No such user' });
        const padre = destino.padre ? cuentas.get(destino.padre) : null;
        const entra = cuerpo.operation === 'in';
        const todo = cuerpo.all === 'true';

        /* 🔴 LA RAREZA MEDIDA: «todo» no hace nada sobre una caja (grupo 4). Sobre un jugador sí.
           Verificado el 1-sep-2026 con un cajero descartable: cargar 3, «todo» mueve 0, retirar 3
           con monto explícito mueve −3. Se imita para que quede fijado por un test. */
        if (todo && destino.group === '4') return responder({});

        const cuanto = todo ? destino.saldo : Number(cuerpo.amount) || 0;
        if (cuanto <= 0) return responder({});
        if (entra && padre && padre.saldo < cuanto) return responder({});   // no alcanzan las fichas
        if (!entra && destino.saldo < cuanto) return responder({});          // no tiene ese saldo

        destino.saldo += entra ? cuanto : -cuanto;
        if (padre) padre.saldo += entra ? -cuanto : cuanto;
        return responder({});
      }

      /* `useredit` da la ficha de una cuenta, con sus permisos. Una cuenta NO puede leer la
         propia: el motor de verdad contesta que no tiene permiso, y por eso hay que preguntar con
         la credencial raíz. Se imita para que el test lo exija. */
      /* `dashboardinfo`: los números del resumen. A un sub-agente el casino le contesta todo en
         cero — medido el 2-sep-2026 contra el motor de verdad. */
      if (area === 'dashboardinfo') {
        const cero = { data: { numbers: { total_players: { total: 0 }, online_players: { total: 0 } } } };
        if (yo.group === '6') {
          return responder({ charts: { summary_stats: cero, active_players: cero, active_halls: cero } });
        }
        const mios = hijosDe(query.id || yo.id);
        const jug = mios.reduce((a, c) => a + hijosDe(c.id).length, 0);
        return responder({ charts: { summary_stats:
          { data: { numbers: { total_players: { total: jug }, online_players: { total: 0 } } } } } });
      }

      if (area === 'useredit') {
        const quien = cuentas.get(String(query.id));
        if (!quien) return responder({ error: 'No such user' });
        if (!yo.esRaiz && String(quien.id) === String(yo.id)) return responder({ error: 'No rights' });
        return responder({ fields: quien.permisos || {} });
      }

      if (area === 'createuser' || area === 'adduser') {
        const nuevo = String(30000 + cuentas.size);
        /* La cuenta cuelga del nodo que dice la dirección, no de quien la pide: un agente crea
           jugadores dentro de una de sus cajas. Al revés, la verificación del alta la busca donde
           no está y contesta «ese nombre ya está usado» con la cuenta recién creada. */
        poner({ id: nuevo, login: cuerpo.login, group: cuerpo.group || 5, padre: query.id || yo.id, saldo: 0 });
        return responder({});
      }

      if (area === 'delete') {
        const c = cuentas.get(String(query.id));
        if (c && cuerpo.delete === 'true') c.borrada = true;
        return responder({});
      }

      return responder({});
    });
  });

  return {
    servidor: srv,
    escuchar: (puerto) => new Promise((r) => srv.listen(puerto, r)),
    cerrar: () => new Promise((r) => srv.close(r)),
    cuentas,
    pedidos,
  };
}

module.exports = { crearMotorFalso };
