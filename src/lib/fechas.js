/**
 * fechas.js — helpers de fecha/hora en zona horaria del negocio (ART por default).
 * El snapshot de TC y los cierres mensuales se calculan en hora Argentina.
 */
const TZ = process.env.APP_TZ || 'America/Argentina/Buenos_Aires';

function partsTZ(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = {};
  f.formatToParts(d).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  if (p.hour === '24') p.hour = '00';
  return p; // {year,month,day,hour,minute,second}
}

const nowISO = () => new Date().toISOString();
const fechaTZ = (d = new Date()) => { const p = partsTZ(d); return `${p.year}-${p.month}-${p.day}`; };
const horaTZ = (d = new Date()) => { const p = partsTZ(d); return `${p.hour}:${p.minute}`; };
const mesTZ = (d = new Date()) => { const p = partsTZ(d); return `${p.year}-${p.month}`; };
const mesDe = (fecha) => String(fecha || '').slice(0, 7); // 'YYYY-MM' de una fecha/datetime
const horaNum = (d = new Date()) => { const p = partsTZ(d); return Number(p.hour); };

module.exports = { TZ, partsTZ, nowISO, fechaTZ, horaTZ, mesTZ, mesDe, horaNum };
