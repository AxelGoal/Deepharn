#!/bin/bash
# Instala Deepharn: crea su perfil, mete los plugins y compila la app.
#
# Uso:  ./instalar.sh
#
# No toca ningún perfil que ya tengas: Deepharn vive en el suyo, `deepharn`.
set -euo pipefail

cd "$(dirname "$0")"
PERFIL="${DSH_HOME:-$HOME/.dsh}/profiles/deepharn"

echo "→ Comprobando lo que hace falta"
command -v node >/dev/null || { echo "   Falta Node. Instálalo desde https://nodejs.org"; exit 1; }
command -v pnpm >/dev/null || { echo "   Falta pnpm. Instálalo con:  npm i -g pnpm"; exit 1; }
command -v swiftc >/dev/null || { echo "   Faltan las Command Line Tools. Instálalas con:  xcode-select --install"; exit 1; }

DSH="$(command -v dsh || true)"
if [ -z "$DSH" ]; then
  echo "   No tienes dsh instalado. Instálalo con:  npm i -g @deepseek-ai/dsh"
  exit 1
fi

echo "→ Preparando el perfil deepharn"
if [ ! -d "$PERFIL" ]; then
  BASE="${DSH_HOME:-$HOME/.dsh}/profiles/web"
  [ -d "$BASE" ] || { echo "   Arranca 'dsh web' una vez para que se cree el perfil base, y vuelve a ejecutar esto."; exit 1; }
  cp -R "$BASE" "$PERFIL"
  node -e "
    const fs = require('fs'), p = '$PERFIL/package.json';
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m.name = 'dsh-profile-deepharn';
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  "
  echo "   Creado en $PERFIL"
else
  echo "   Ya existía"
fi

echo "→ Instalando los plugins"
"$DSH" plugin --profile deepharn add "$PWD/plugins/deepharn-front" >/dev/null
"$DSH" plugin --profile deepharn add "$PWD/plugins/deepharn-piel" >/dev/null

echo "→ Montándolos en el árbol"
PARCHE="$PERFIL/cordis.patch.yml"
[ -f "$PARCHE" ] || echo "[]" > "$PARCHE"
node -e "
  const fs = require('fs'), p = '$PARCHE';
  let s = fs.readFileSync(p, 'utf8');
  // Un archivo de parches vacío se desactiva con [], pero al añadir filas hay
  // que quitarlo o el YAML deja de ser una lista.
  s = s.replace(/^\s*\[\]\s*$/m, '');
  for (const nombre of ['deepharn-front', 'deepharn-piel']) {
    if (s.includes('name: ' + nombre)) continue;
    s += '\n- insert:\n    - id: ' + nombre + '\n      name: ' + nombre + '\n';
  }
  fs.writeFileSync(p, s.trim() + '\n');
"

echo "→ Compilando la app"
( cd app && ./construir.sh >/dev/null )

echo
echo "Listo. Ábrela desde Launchpad o con:  open -a Deepharn"
echo "Sin app:  dsh --profile deepharn   →   http://127.0.0.1:3081/deepharn/"
