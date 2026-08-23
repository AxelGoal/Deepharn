# Deepharn

Un escritorio propio para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
en macOS, para trabajar con el agente en todo lo que no es programar.

No es un tema ni un envoltorio de la interfaz oficial: es un **frontend distinto**
que habla con el harness por su API, servido desde el propio harness y metido en
una ventana nativa.

## Qué hace

- **Conversaciones agrupadas** en En marcha / Hoy / Antes, con su hora y sus tokens.
- **Sala de control** con lo que está corriendo, y **entregables** con los archivos
  que ha producido la conversación.
- **En uso**: qué skills ve el agente, qué subagentes ha lanzado y qué plugins
  están cargados.
- **Selector de modelo y de esfuerzo de razonamiento**, con filtro (OpenRouter
  ofrece más de cien modelos).
- **Ajustes** con instalador de plugins y gestor de skills, sin bajar a la terminal.
- Borrar conversaciones y proyectos, renombrarlos.
- Tres columnas plegables y modo «solo chat». Claro y oscuro.

La respuesta del agente se pinta según se escribe, y el texto se renderiza como
markdown: párrafos, viñetas, código.

## Cómo está montado

Tres piezas, cada una con un trabajo:

| Pieza | Qué es |
|---|---|
| `app/` | Concha de escritorio en Swift + WKWebView. Arranca el harness, lo vigila y lo para al salir. |
| `plugins/deepharn-front/` | Plugin de host: sirve el frontend en `/deepharn` y añade endpoints propios para instalar plugins y gestionar skills. |
| `plugins/deepharn-piel/` | Plugin de cliente: reescribe los tokens de color y tipografía de la interfaz oficial. Opcional. |

El frontend es HTML, CSS y JavaScript a pelo. Sin framework, sin compilación, sin
dependencias: se edita y se recarga.

**Por qué se sirve desde el propio harness:** su API compara el `Host` de cada
petición y rechaza lo que venga de otro puerto. Servir el frontend desde fuera no
funciona; desde dentro, las llamadas a `/api` salen gratis.

## Instalar

Necesitas macOS 14+, Node 22+, pnpm y las Command Line Tools de Xcode.

```bash
# 1. El harness, si no lo tienes
npm i -g @deepseek-ai/dsh

# 2. Un perfil propio, para no tocar el que ya uses
cp -R ~/.dsh/profiles/web ~/.dsh/profiles/deepharn

# 3. Los plugins de este repo
dsh plugin --profile deepharn add ./plugins/deepharn-front
dsh plugin --profile deepharn add ./plugins/deepharn-piel
```

Y sus filas en `~/.dsh/profiles/deepharn/cordis.patch.yml`:

```yaml
- insert:
    - id: deepharn-front
      name: deepharn-front
- insert:
    - id: deepharn-piel
      name: deepharn-piel
```

Luego la app:

```bash
cd app && ./construir.sh
```

Se compila, se instala en `/Applications` y se abre desde Launchpad. También vale
sin app: `dsh --profile deepharn` y abrir `http://127.0.0.1:3081/deepharn/`.

## Cómo arranca

Abrir la app es lo único que hay que hacer:

1. Comprueba los puertos 3081-3083, preguntando por **su propio endpoint** y no
   solo si el puerto responde — así no se engancha a un harness ajeno.
2. Si lo encuentra, se engancha y no arranca nada. Al cerrarla, ese servidor
   sigue vivo.
3. Si no hay nada, lo lanza: `dsh` instalado, la caché de npx, o
   `npx -y @deepseek-ai/dsh`.
4. Si falla, dice por qué, enseña el registro y ofrece reintentar.
5. Al salir, para el harness solo si lo arrancó ella.

## Lo que aprendimos por el camino

Está en [COMO-ESTA-HECHO.md](COMO-ESTA-HECHO.md): la API del harness, sus métodos
y sus trampas. Si vas a construir algo parecido, ahí tienes el mapa.

## Estado

Funciona y se usa a diario, pero es joven y el harness que hay debajo está en
*developer preview*, así que rompe compatibilidad de vez en cuando.

**Lo que falta:** streaming letra a letra por WebSocket (ahora sondea), adjuntar
archivos, y un botón de reinicio que no pase por el menú.

## Licencia

MIT.
