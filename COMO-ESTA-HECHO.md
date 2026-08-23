# Cómo está hecho

Notas de construcción de Deepharn. Casi todo lo de aquí se averiguó llamando a la
API y leyendo el código instalado, no en la documentación: sirve como mapa para
quien quiera construir su propio cliente del harness.

## El punto de partida

DeepSeek Harness es un árbol de plugins: 135 filas en un perfil de fábrica, de las
cuales 36 son interfaz. Todo se compone al arrancar desde el perfil
(`~/.dsh/profiles/<nombre>`), y cualquier fila se puede sustituir con un parche
propio.

Volcar el árbol real es el primer paso de cualquier cosa:

```bash
dsh --profile <perfil> --dump-config
```

## Por qué un frontend aparte y no plugins de interfaz

El primer intento fue el evidente: registrar componentes en los huecos de la
interfaz oficial. Se acaba pronto.

El armazón declara cuatro huecos —`sidebar`, `conversation`, `details` y
`shell.overlay`— y **los tres primeros son de plaza única y ya tienen dueño**.
`details`, que sería la columna derecha, la ocupa `ui-conversation`. Solo
`shell.overlay` admite añadidos de terceros, y de ahí no sale una aplicación:
sale un panel flotando en una esquina.

Para llevarse una columna al terreno propio hay que **desactivar la fila de su
dueño y registrar la nuestra declarando los mismos huecos hijos**, para no romper
a los plugins que cuelgan de ella. Es cirugía. Escribir un frontend propio contra
la API resultó más barato y más libre.

## La API

Un solo patrón, muy limpio:

```
POST /api/<método>
  → { "type":"client-request", "rpcId":"<uuid>", "method":"<método>", "payload":{…} }
  ← { "type":"server-response", "rpcId":"…", "result":{ "ok":true, "value":{…} } }
```

### Cómo descubrir un método sin efectos secundarios

Llama con `payload: {}`. El servidor contesta `bad-request` y **enumera los
campos que faltan**; con un valor inválido en un campo, enumera los aceptados.
No hace falta ejecutar nada para averiguar la forma de una llamada.

```bash
curl -s -X POST http://127.0.0.1:3081/api/session.prompt \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"session.prompt","payload":{}}'
# → faltan: sessionId, mode, content
```

### Métodos confirmados

| Método | Carga | Devuelve |
|---|---|---|
| `host.describe` | `{}` | versión, cwd, proveedor, modelo, si puede abrir rutas |
| `session.list` | `{}` | `items[]` con `sessionId`, `updatedAt`, `running`, `blank`, `cwd`, `projections` |
| `session.history` | `{sessionId}` | `events[]` de la conversación |
| `session.prompt` | `{sessionId, mode, content}` | envía; `mode` es `queue` o `steer` |
| `session.create` | `{}` | crea una conversación |
| `session.models` | `{sessionId}` | `current`, `groups[]` con modelos y sus esfuerzos |
| `session.selectModel` | `{sessionId, provider, model, reasoningEffort?}` | cambia el modelo |
| `workspace.list` | `{}` | `items[]` **y `archivedSessionIds`** |
| `workspace.archiveSession` | `{sessionId}` | borra una conversación |
| `workspace.delete` | `{workspaceId}` | borra un proyecto |
| `workspace.rename` | `{workspaceId, title}` | lo renombra |
| `skill.list` | `{sessionId}` | las skills que ve esa conversación |
| `subagent.list` | `{parentSessionId}` | ojo: **no** `sessionId` |
| `llm.providers` | `{}` | proveedores y cuáles están activos |
| `pluginInventory/list` | `{args:{}}` | las filas del árbol; ojo al envoltorio `args` |

### Los eventos del historial

Lo que hace falta para pintar una conversación:

- `user/message` → `data.content[].text`. **Filtra por `data.source.kind === 'user'`**:
  el log guarda como mensaje del usuario tanto lo que escribes tú como el contexto
  que inyectan los plugins (política del sandbox, catálogo de skills, recordatorios).
- `assistant/message` → `data.message.content[].text`.
- `assistant/chunk` → `data.chunk` con `{type:'text-delta', text}`. Juntando los
  deltas posteriores al último `assistant/message` se pinta lo que el modelo está
  escribiendo **sin tocar los WebSocket**.

## Trampas que costaron tiempo

**El frontend tiene que ir en el mismo origen que `/api`.** El cortafuegos compara
el `Host` de cada petición y rechaza lo que venga de otro puerto. Servirlo desde
un servidor aparte no funciona. Se resuelve registrando una ruta en el propio
servidor del harness:

```js
ctx.webServer.register({ kind: 'prefix', path: '/deepharn', handler })
```

**Archivar no quita la sesión de `session.list`.** El harness lleva la cuenta
aparte, en `archivedSessionIds` dentro de `workspace.list`. Sin cruzar las dos
listas, lo borrado sigue apareciendo.

**`skill.list` exige que la conversación esté adjunta** y `session.history` **no**
la adjunta: en conversaciones frías responde `session-not-found (not attached)`.

**Una WKWebView sin delegado de interfaz ignora `confirm()` y `prompt()`** y
devuelve `false` en silencio. Un botón de borrar funcionaría en el navegador y no
haría nada dentro de la app, sin un solo error. Los diálogos tienen que ser
propios.

**Insertar filas en un parche no es lo que parece.** Una entrada suelta con `id:`
**sobrescribe** una fila existente; para añadir hay que envolverla:

```yaml
- insert:
    - id: mi-plugin
      name: nombre-del-paquete
```

## Plugins de cliente, si los necesitas

El formato del bundle no está publicado, pero se reproduce a mano leyendo el
artefacto de cualquier plugin oficial instalado:

```js
window.__ModuleLoader__.load({
  id: "nombre-del-paquete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // …tu código…
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

El cargador sirve **un solo archivo** por plugin y su `require` no resuelve
archivos hermanos, así que si el código crece hay que concatenarlo (aquí lo hace
`construir.mjs`).

Dos detalles que rompen en silencio:
- El CSS propio necesita más especificidad que la hoja de la app (`html body` en
  vez de `body`), porque la suya se inserta después.
- Un backtick dentro de un template literal rompe el módulo entero y el plugin
  deja de cargar sin decir nada. `node --check` antes de reiniciar.

## Skills

Van en **`~/.agents/skills/`**, no en la carpeta de skills de tu editor. Una skill
es una carpeta con su `SKILL.md`. **El catálogo se lee al arrancar**: una skill
nueva no aparece hasta reiniciar.

Y una que cuesta encontrar: **un `: ` (dos puntos y espacio) dentro de un
`description:` sin comillas invalida el frontmatter** y el harness se salta la
skill sin avisar. Otros agentes lo toleran. Se arregla con un bloque plegado:

```yaml
description: >-
  Texto con: dos puntos, "comillas" y lo que haga falta.
```

## Decisiones de la concha

**Swift + WKWebView en vez de Tauri o Electron.** Tauri obligaba a instalar toda
la cadena de Rust (~1,5 GB) para acabar envolviendo un WebView que macOS ya trae.
Electron pesa lo que pesa. Con las Command Line Tools ya instaladas, la concha son
300 líneas de Swift y un binario de 130 KB.

**El icono se dibuja por código** (`hacer-icono.swift`, CoreGraphics): ni imágenes
en el repo ni dependencias de diseño.

**Comprobar el endpoint propio, no el puerto.** Preguntar «¿responde el 3081?»
hace que la app se cuelgue de cualquier harness ajeno. Preguntar por
`/deepharn/api/skills` responde a la pregunta de verdad: «¿está *lo mío* ahí?».
