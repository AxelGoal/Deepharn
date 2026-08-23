#!/bin/bash
# Construye Deepharn.app. No necesita Xcode completo: basta con las
# Command Line Tools. Uso: ./construir.sh
set -euo pipefail

cd "$(dirname "$0")"
APP="build/Deepharn.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Deepharn</string>
  <key>CFBundleDisplayName</key><string>Deepharn</string>
  <key>CFBundleIdentifier</key><string>io.deepharn.app</string>
  <key>CFBundleExecutable</key><string>Deepharn</string>
  <key>CFBundleIconFile</key><string>Deepharn</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

# El icono se dibuja por código: ni imágenes sueltas ni dependencias.
if [ ! -f build/Deepharn.icns ]; then
  swift hacer-icono.swift build/Deepharn.iconset >/dev/null
  iconutil -c icns build/Deepharn.iconset -o build/Deepharn.icns
fi
cp build/Deepharn.icns "$APP/Contents/Resources/Deepharn.icns"

swiftc -O \
  -framework AppKit -framework WebKit \
  -o "$APP/Contents/MacOS/Deepharn" \
  Sources/main.swift

codesign --force --sign - "$APP" >/dev/null 2>&1 || true

# Y se instala en /Applications, para que no haya dos copias distintas dando
# vueltas: la que abres desde Launchpad es siempre la recién compilada.
rm -rf /Applications/Deepharn.app 2>/dev/null
if cp -R "$APP" /Applications/ 2>/dev/null; then
  codesign --force --sign - /Applications/Deepharn.app >/dev/null 2>&1 || true
  # Se borra la copia de compilación: si no, Spotlight y Launchpad enseñan dos
  # Deepharn y acabas abriendo la vieja.
  rm -rf "$APP"
  # Que el Finder se entere del icono nuevo.
  touch /Applications/Deepharn.app
  echo "Listo e instalada en /Applications/Deepharn.app"
  echo "Ábrela desde Launchpad, o:  open -a Deepharn"
else
  echo "Listo: $APP (no he podido copiarla a /Applications)"
fi
