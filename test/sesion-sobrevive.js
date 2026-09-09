/* Se simula lo que pasa en un despliegue: alguien entra, el proceso se muere, y con la MISMA
   cookie del navegador tiene que seguir adentro. Se corre en dos procesos de verdad, no
   vaciando un Map, porque lo que se quiere probar es justamente que sobreviva al reinicio. */
const auth = require(require('path').join(__dirname, '../src/caja/caja-auth.js'));
const { db } = require(require('path').join(__dirname, '../src/db'));
const paso = process.argv[2];

if (paso === 'guardar') {
  // Se fabrica una sesión a mano con la misma forma que arma `entrar`.
  const crypto = require('crypto');
  const sid = crypto.randomBytes(24).toString('base64url');
  const { encrypt } = require(require('path').join(__dirname, '../src/crypto-util'));
  const datos = JSON.stringify({
    login: 'CSophi', id: '7382837', group: '4', rol: 'cajero', moneda: 'ARS',
    url: 'https://admin.ganamos-lat.com', caja: null,
    hide_hall_balance: false, disable_statistic: false,
    token: null, cookie: 'PHPSESSID=abc123deprueba',
  });
  db.prepare('INSERT OR REPLACE INTO caja_sesiones (sid, vence, datos) VALUES (?, ?, ?)')
    .run(sid, Date.now() + 3600e3, encrypt(datos));
  const guardado = db.prepare('SELECT datos FROM caja_sesiones WHERE sid = ?').get(sid).datos;
  console.log(JSON.stringify({ sid, cifrado: guardado.startsWith('enc:v1:'),
    claroEnDisco: /PHPSESSID|CSophi/.test(guardado) }));
} else {
  const sid = process.argv[3];
  const req = { headers: { cookie: '' } };
  // Se entra por la puerta de verdad: el middleware, con la cookie firmada que tendría el navegador.
  const res = { append(){}, status(){ return this; }, json(o){ this.cuerpo = o; return this; } };
  const falso = { append(){} };
  auth.ponerCookie(falso, sid);
  // La cookie firmada se rearma igual que `ponerCookie`.
  const crypto = require('crypto');
  const SECRETO = process.env.SESSION_SECRET || 'dev-insecure-secret-cambiar-en-prod';
  const firma = crypto.createHmac('sha256', SECRETO).update(sid).digest('base64url');
  req.headers.cookie = `caja_sid=${encodeURIComponent(sid + '.' + firma)}`;
  let paso2 = false;
  auth.requerida(req, res, () => { paso2 = true; });
  console.log(JSON.stringify({
    entro: paso2,
    login: paso2 ? req.caja.login : null,
    revivida: paso2 ? req.caja.revivida === true : null,
    tieneClienteDeSesion: paso2 ? !!req.caja.conSesion : null,
    error: paso2 ? null : (res.cuerpo || {}).error,
  }));
}
