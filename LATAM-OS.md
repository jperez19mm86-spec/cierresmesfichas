# LATAM Games OS — esqueleto (v0.2.0)

Sistema comercial/financiero construido **encima de la MATRIZ** (venta-fichas). No reemplaza nada:
extiende. La parte operativa (login al panel, /pedir, cargar fichas, avisos) sigue igual en `/`;
el núcleo nuevo vive en `/os`.

## Cómo correr
```bash
npm install
npm start          # http://localhost:4600  (panel operativo)
                   # http://localhost:4600/os  (panel comercial OS) — requiere login
PANEL_PASSWORD=... SESSION_SECRET=... CRED_KEY=...   # setear en prod (Railway)
```
Node 22 en Railway (better-sqlite3 trae binario). Local con Node 24 funciona con `better-sqlite3 ^12`.

Prueba end-to-end: `node test/smoke.js` (levanta, ejercita el flujo, baja). 20/20 checks.

## Arquitectura (todo SQLite + decimal.js)
- **lib/money.js** — aritmética EXACTA (strings decimales, nunca floats). ARS 2 dec, USDT 6.
- **lib/fechas.js** — fecha/hora/mes en ART.
- **db.js** — esquema completo (MATRIZ + tablas nuevas). Extiende `clientes` sin romper.
- **historial.js** — motor de VIGENCIAS: `vigencia` (desde fecha) vs `corrección` (retroactivo) + auditoría.
- **stores**: personas, paneles, participaciones (valida 100%), split-base (seed del doc), proveedores,
  tc (snapshots + tc_mes), movimientos, clientes (extendido).
- **services**: tc (criptoya + cron 18:00), split (empresa/LATAM/socios), proveedores (diferencial),
  deuda (cuenta corriente derivada), notify (Telegram v2: carga con USDT + pago).
- **os.routes.js** — todos los endpoints `/api/os/*` (detrás del gate de auth) + sirve `/os`.

## Endpoints clave (`/api/os/*`)
clientes (+precio-base con vigencia, +cuenta), personas, paneles (+override), participaciones (valida 100%),
split-base, proveedores (+panel-proveedores +diferencial), tc (snapshot/ahora/meses/cierre),
movimientos (+carga comercial +pago), reportes (mensual real / diario stub), historial.

## 🕳 Los "agujeros" (a llenar después, a propósito)
1. **API del panel proveedor** — profit por proveedor + IN/OUT/RTP. Hoy: el diferencial recibe los
   `profits` por body (`POST /api/os/paneles/:id/diferencial`). Es el mismo engine 463.life del VPS →
   se puede sondear. Bloquea Fase 3/5.
2. **Fórmula USDT exacta** — hoy: equivalente = fee_ARS / TC. Falta dónde aplican `mezcla_pago_usdt`
   y `ajuste_usdt_pct` (pregunta de negocio).
3. **Fuente del TC** — `TC_SOURCE_URL` (default criptoya/usdt/ars). Confirmar fuente exacta.
4. **Datos** — clientes, %, socios, participaciones y catálogo de proveedores se cargan por el panel
   (o migración futura desde la DB de producción de la MATRIZ).
5. **Carga operativa → comercial** — hoy la carga comercial es un endpoint propio. Engancharla al
   "Cargar" del flujo /pedidos de la MATRIZ es un hook de ~5 líneas (cuando se confirme el flujo).

## Reglas respetadas del doc
Money exacto · vigencias/corrección sin pisar histórico · participaciones suman 100% · split_base y
proveedores configurables (no hardcode) · TC guardado en cada movimiento · cron 18:00 · TC factura manual.
