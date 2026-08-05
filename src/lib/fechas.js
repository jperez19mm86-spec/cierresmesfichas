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

// ── UTC (+0) — el CASINO opera en UTC: los días/meses del acumulado se cortan en UTC ──
const fechaUTC = (d = new Date()) => d.toISOString().slice(0, 10); // 'YYYY-MM-DD' en UTC
const mesUTC = (d = new Date()) => d.toISOString().slice(0, 7);    // 'YYYY-MM' en UTC
const ayerUTC = () => fechaUTC(new Date(Date.now() - 86400000));   // día anterior COMPLETO (UTC)

// ── Cómo se llaman los meses en la grilla del cierre ──────────────────────────────────────
// La planilla original los escribe 'Julio_2026', no en ISO. Vive acá y no en un servicio para
// que lo puedan usar los dos lados sin que se requieran entre ellos.
const MESES_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** '2026-07' → 'Julio_2026' */
function mesCierre(iso) {
  const [y, m] = String(iso || '').split('-');
  return MESES_ES[Number(m) - 1] ? `${MESES_ES[Number(m) - 1]}_${y}` : String(iso);
}

/** 'Julio_2026' → '2026-07'. Tolera 'JULIO_26' y 'julio_2026'; null si no se entiende. */
function mesISO(label) {
  const m = /^\s*([A-Za-zÁÉÍÓÚáéíóúÑñ]+)[_\s-]+(\d{2}|\d{4})\s*$/.exec(String(label || ''));
  if (!m) return null;
  const i = MESES_ES.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (i < 0) return null;
  const y = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${y}-${String(i + 1).padStart(2, '0')}`;
}

module.exports = { TZ, partsTZ, nowISO, fechaTZ, horaTZ, mesTZ, mesDe, horaNum, fechaUTC, mesUTC, ayerUTC, MESES_ES, mesCierre, mesISO };
