# Venta de Fichas — Panel

Panel local para vender fichas a administradores en **múltiples sistemas de casino**.
Cada sistema se entra por **usuario y contraseña** (no usa API token) y tiene sus propias cajas,
por eso se puede tener varios cargados y elegir cuál usar.

> Pantalla 1 (esta versión): **gestor de sistemas** — agregar/editar/borrar páginas de agente,
> ponerles nombre, elegir la activa y probar la conexión.
> Próximas: buscar administradores en el sistema activo y vender fichas.

## Requisitos
- [Node.js](https://nodejs.org) 18 o superior (probado en v22).

## Cómo correrlo
```bash
npm install
npm start
```
Después abrí **http://localhost:4600** en el navegador.

Para cambiar el puerto, copiá `.env.example` a `.env` y editá `PORT`.

## Cómo se usa
1. En **➕ Agregar página / sistema** poné:
   - **Nombre**: lo que quieras (ej. `Casino`, `Europa`). Es editable después.
   - **URL del admin**: ej. `admin.463.life` (sin `https://`, se agrega solo).
   - **Usuario** y **Contraseña** de ese sistema.
2. Apretá **🔌 Probar** para verificar que el usuario/contraseña entran, y después **Agregar**.
3. Repetí para cada sistema. Elegí el **activo** con **★ Usar este**.

## Dónde se guardan los datos
Los sistemas (con sus contraseñas) se guardan en `data/systems.json`, **solo en tu máquina**.
Esa carpeta está en `.gitignore`, así que **nunca se sube a GitHub**.

## Estructura
```
src/
  index.js          servidor Express + endpoints
  systems-store.js  guardado local (JSON) de los sistemas
  casino-client.js  login usuario/contraseña → sesión (PHPSESSID) + verificación
public/
  index.html        la interfaz del panel
data/                systems.json (local, gitignored)
```
