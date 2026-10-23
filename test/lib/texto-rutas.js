/* El texto de las rutas del OS, para los chequeos que leen el código. Desde la fase 2 las rutas
   no están en un solo archivo sino partidas por tema en src/rutas/: se leen todas juntas, en el
   orden en que se montan, así cada chequeo busca lo mismo que buscaba en os.routes.js. */
const fs = require('fs');
const path = require('path');

module.exports = function textoRutas() {
  const src = path.join(__dirname, '..', '..', 'src');
  const indice = fs.readFileSync(path.join(src, 'os.routes.js'), 'utf8');
  const sectores = [...indice.matchAll(/require\('\.\/rutas\/([\w-]+)\.routes'\)/g)].map((m) => m[1]);
  return [indice, ...['comun.js', ...sectores.map((s) => `${s}.routes.js`)]
    .map((f) => fs.readFileSync(path.join(src, 'rutas', f), 'utf8'))].join('\n');
};
