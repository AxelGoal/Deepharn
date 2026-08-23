// Deepharn — frontend propio sobre la API del harness.
//
// Habla el mismo protocolo que la interfaz oficial: POST /api/<método> con el
// sobre { type: "client-request", rpcId, method, payload } y respuesta
// { type: "server-response", rpcId, result: { ok, value | error } }.
//
// Todavía no consume los WebSocket de eventos: refresca por sondeo cada 4 s.
// Enviar mensajes llega en la siguiente vuelta.

const $ = (id) => document.getElementById(id)

const estado = {
  host: null,
  espacios: [],
  sesiones: [],
  actual: null,
  historia: null,
  archivadas: new Set(),
}

// ── API ──────────────────────────────────────────────────────────────────

async function rpc(method, payload = {}) {
  const respuesta = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (!respuesta.ok) throw new Error(`${method}: HTTP ${respuesta.status}`)
  const sobre = await respuesta.json()
  const resultado = sobre?.result
  if (!resultado?.ok) throw new Error(`${method}: ${resultado?.error?.message ?? 'error desconocido'}`)
  return resultado.value
}

// ── utilidades ───────────────────────────────────────────────────────────

const HOY = () => new Date().setHours(0, 0, 0, 0)

function hora(ms) {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
}

function miles(n) {
  if (!Number.isFinite(n) || n === 0) return null
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace('.', ',')}k`
}

const valores = (s) => s?.projections?.values ?? s?.projections

function tokensDe(s) {
  const u = valores(s)?.tokenUsage
  if (!u) return 0
  return (u.uncachedInputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
}

function tituloDe(s) {
  return valores(s)?.title || s?.cwd?.split('/').filter(Boolean).pop() || s.sessionId
}

const el = (tag, props = {}, hijos = []) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (v !== null && v !== undefined) n.setAttribute(k, v)
  }
  for (const h of [].concat(hijos)) if (h) n.append(h)
  return n
}

// ── pintar ───────────────────────────────────────────────────────────────

function pintarBarra() {
  const h = estado.host
  if (!h) return
  const nombre = h.cwd?.split('/').filter(Boolean).pop() ?? 'Deepharn'
  $('espacio-nombre').textContent = nombre
  $('espacio-ruta').textContent = h.cwd ?? ''
  $('espacio-inicial').textContent = nombre.slice(0, 2).toUpperCase()
  const sesion = estado.sesiones.find((s) => s.sessionId === estado.actual)
  $('modelo').textContent = valores(sesion)?.model ?? h.model ?? '—'

  pintarEsfuerzo()

  const enMarcha = estado.sesiones.filter((s) => s.running && !estado.archivadas.has(s.sessionId)).length
  const pastilla = $('pastilla-marcha')
  pastilla.classList.toggle('oculto', enMarcha === 0)
  $('marcha-texto').textContent = enMarcha === 1 ? '1 tarea en curso' : `${enMarcha} tareas en curso`
}

function pintarLista() {
  const filtro = $('buscar').value.trim().toLowerCase()
  const grupos = { marcha: [], hoy: [], antes: [] }
  const inicio = HOY()

  for (const s of estado.sesiones) {
    if (estado.archivadas.has(s.sessionId)) continue
    if (filtro && !tituloDe(s).toLowerCase().includes(filtro)) continue
    if (s.running) grupos.marcha.push(s)
    else if (Number.isFinite(s.updatedAt) && s.updatedAt >= inicio) grupos.hoy.push(s)
    else grupos.antes.push(s)
  }
  const porFecha = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  for (const g of Object.values(grupos)) g.sort(porFecha)

  const lista = $('lista')
  lista.replaceChildren()

  const bloque = (titulo, sesiones, viva) => {
    if (!sesiones.length) return null
    const cab = el('h4', {}, [document.createTextNode(titulo), el('em', { text: String(sesiones.length) })])
    const g = el('div', { class: `grupo${viva ? ' viva' : ''}` }, [cab])
    for (const s of sesiones) {
      const tk = miles(tokensDe(s))
      const detalle = el('small', {}, [el('span', { text: hora(s.updatedAt) })])
      if (tk) detalle.append(el('span', { class: 'mono', text: `${tk} tk` }))
      const borrar = el('button', {
        class: 'borrar-conv',
        title: 'Borrar esta conversación',
        onclick: (e) => { e.stopPropagation(); borrarConversacion(s) },
      }, [document.createTextNode('×')])

      const boton = el('button', {
        class: `conv${s.running ? ' viva' : ''}${s.sessionId === estado.actual ? ' actual' : ''}`,
        onclick: () => abrir(s.sessionId),
      }, [
        el('i'),
        el('span', {}, [el('b', { text: tituloDe(s) }), detalle]),
        borrar,
      ])
      g.append(boton)
    }
    return g
  }

  const partes = [
    bloque('En marcha', grupos.marcha, true),
    bloque('Hoy', grupos.hoy, false),
    bloque('Antes', grupos.antes, false),
  ].filter(Boolean)

  if (!partes.length) lista.append(el('div', { class: 'nada', text: 'No hay conversaciones.' }))
  else lista.append(...partes)
}

function pintarControl() {
  const cuerpo = $('control')
  cuerpo.replaceChildren()

  const vivas = estado.sesiones.filter((s) => s.running && !estado.archivadas.has(s.sessionId))
  $('n-control').textContent = String(vivas.length)

  if (!vivas.length) {
    cuerpo.append(el('div', { class: 'nada', text: 'Nada en marcha ahora mismo.' }))
    return
  }

  for (const s of vivas) {
    const tk = miles(tokensDe(s))
    const pasos = valores(s)?.sessionStats?.steps
    const pie = el('div', { class: 'pie' }, [
      tk ? el('span', { class: 'mono', text: `${tk} tk` }) : null,
      Number.isFinite(pasos) && pasos > 0 ? el('span', { text: `${pasos} pasos` }) : null,
    ])
    cuerpo.append(el('div', { class: 'tarjeta' }, [
      el('div', { class: 'alto' }, [
        el('i'),
        el('b', { text: tituloDe(s) }),
        el('small', { class: 'mono', text: hora(s.updatedAt) }),
      ]),
      pie,
    ]))
  }
}

function pintarEntregables() {
  const cuerpo = $('entregables')
  cuerpo.replaceChildren()
  const eventos = estado.historia?.events ?? []

  // Un entregable es un archivo que una herramienta ha creado o modificado.
  const rutas = []
  for (const fila of eventos) {
    const d = fila?.event?.data
    const posibles = d?.locations ?? d?.result?.locations
    if (Array.isArray(posibles)) {
      for (const l of posibles) {
        const p = typeof l === 'string' ? l : l?.path
        if (p && !rutas.includes(p)) rutas.push(p)
      }
    }
  }

  $('n-entregables').textContent = String(rutas.length)
  if (!rutas.length) {
    cuerpo.append(el('div', { class: 'nada', text: 'Esta conversación no ha producido archivos.' }))
    return
  }
  for (const p of rutas.slice(0, 20)) {
    cuerpo.append(el('div', { class: 'tarjeta' }, [
      el('div', { class: 'alto' }, [el('b', { text: p.split('/').pop() })]),
      el('div', { class: 'pie' }, [el('span', { class: 'mono', text: p })]),
    ]))
  }
}


// ── texto con formato ────────────────────────────────────────────────────
//
// El agente escribe markdown. Volcarlo en crudo daba un ladrillo sin sangría
// ni respiración. Esto es lo justo: párrafos, viñetas, listas numeradas,
// encabezados, código en línea y bloques de código. Se construye con nodos,
// nunca con innerHTML, para que un mensaje no pueda inyectar nada.

function enLinea(destino, texto) {
  // `código`, **negrita**, *cursiva*
  const partes = texto.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g)
  for (const parte of partes) {
    if (!parte) continue
    if (parte.startsWith('`') && parte.endsWith('`') && parte.length > 2) {
      destino.append(el('code', { text: parte.slice(1, -1) }))
    } else if (parte.startsWith('**') && parte.endsWith('**') && parte.length > 4) {
      destino.append(el('strong', { text: parte.slice(2, -2) }))
    } else if (parte.startsWith('*') && parte.endsWith('*') && parte.length > 2) {
      destino.append(el('em', { text: parte.slice(1, -1) }))
    } else {
      destino.append(document.createTextNode(parte))
    }
  }
  return destino
}

function formatear(texto) {
  const raiz = el('div', { class: 'prosa' })
  const lineas = texto.split('\n')
  let i = 0

  const esViñeta = (l) => /^\s*[-*•]\s+/.test(l)
  const esNumerada = (l) => /^\s*\d+[.)]\s+/.test(l)

  while (i < lineas.length) {
    const linea = lineas[i]

    if (linea.trim() === '') { i++; continue }

    // bloque de código
    if (linea.trim().startsWith('```')) {
      const trozo = []
      i++
      while (i < lineas.length && !lineas[i].trim().startsWith('```')) { trozo.push(lineas[i]); i++ }
      i++
      raiz.append(el('pre', {}, [el('code', { text: trozo.join('\n') })]))
      continue
    }

    // encabezado
    const enc = /^(#{1,4})\s+(.*)$/.exec(linea)
    if (enc) {
      raiz.append(enLinea(el('h3', { class: 'prosa-h' }), enc[2]))
      i++
      continue
    }

    // lista
    if (esViñeta(linea) || esNumerada(linea)) {
      const numerada = esNumerada(linea)
      const lista = el(numerada ? 'ol' : 'ul', { class: 'prosa-lista' })
      while (i < lineas.length) {
        // Un hueco entre puntos no rompe la lista: los modelos separan los
        // elementos con una línea en blanco y antes eso creaba dos listas,
        // así que la numeración volvía a empezar en 1.
        if (lineas[i].trim() === '') {
          let j = i
          while (j < lineas.length && lineas[j].trim() === '') j++
          if (j < lineas.length && (esViñeta(lineas[j]) || esNumerada(lineas[j]))) { i = j; continue }
          break
        }
        if (!esViñeta(lineas[i]) && !esNumerada(lineas[i])) break
        const limpio = lineas[i].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
        lista.append(enLinea(el('li'), limpio))
        i++
      }
      raiz.append(lista)
      continue
    }

    // párrafo: junta líneas hasta un hueco o un cambio de bloque
    const parrafo = []
    while (i < lineas.length && lineas[i].trim() !== '' && !esViñeta(lineas[i]) && !esNumerada(lineas[i]) && !lineas[i].trim().startsWith('```') && !/^#{1,4}\s/.test(lineas[i])) {
      parrafo.push(lineas[i].trim())
      i++
    }
    raiz.append(enLinea(el('p'), parrafo.join(' ')))
  }

  return raiz
}

function textoDe(contenido) {
  if (!Array.isArray(contenido)) return ''
  return contenido
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    // El harness inyecta recordatorios de sistema dentro del mensaje del
    // usuario. Son para el modelo, no para quien lee.
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim()
}

function pintarHilo() {
  const hilo = $('hilo')
  hilo.replaceChildren()

  if (!estado.actual) {
    hilo.append(el('div', { class: 'vacio', text: 'Elige una conversación de la izquierda.' }))
    return
  }

  const eventos = estado.historia?.events ?? []
  const interior = el('div', { class: 'interior' })
  let pintados = 0
  let ultimoMensaje = -1

  for (const fila of eventos) {
    if (fila?.event?.type === 'assistant/message') ultimoMensaje = fila.event.seq ?? ultimoMensaje
  }

  for (const fila of eventos) {
    const ev = fila?.event
    if (!ev) continue

    if (ev.type === 'user/message') {
      // El log guarda como "user/message" tanto lo que escribes tú como el
      // contexto que inyectan los plugins (política del sandbox, catálogo de
      // skills…). Solo lo tuyo se pinta.
      if (ev.data?.source?.kind !== 'user') continue
      const texto = textoDe(ev.data?.content)
      if (!texto) continue
      interior.append(el('div', { class: 'msg usuario' }, [
        el('div', { class: 'meta mono', text: hora(ev.time) }),
        el('div', { class: 'burbuja' }, [el('div', { class: 'cuerpo-texto' }, [formatear(texto)])]),
      ]))
      pintados++
    }

    if (ev.type === 'assistant/message') {
      const texto = textoDe(ev.data?.message?.content)
      if (!texto) continue
      interior.append(el('div', { class: 'msg agente' }, [
        el('div', { class: 'autor' }, [
          el('span', { class: 'marca-mini', text: 'D' }),
          el('b', { text: 'Harness' }),
          el('span', { class: 'meta mono', text: hora(ev.time) }),
        ]),
        el('div', { class: 'cuerpo-texto' }, [formatear(texto)]),
      ]))
      pintados++
    }
  }

  // Lo que el modelo está escribiendo ahora mismo: los text-delta posteriores
  // al último mensaje ya confirmado. Así la respuesta aparece según se produce
  // en vez de salir de golpe al final.
  const enVuelo = eventos
    .filter((f) => f?.event?.type === 'assistant/chunk' && (f.event.seq ?? 0) > ultimoMensaje)
    .map((f) => f.event.data?.chunk)
    .filter((c) => c?.type === 'text-delta' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')

  if (enVuelo.trim()) {
    interior.append(el('div', { class: 'msg agente' }, [
      el('div', { class: 'autor' }, [
        el('span', { class: 'marca-mini', text: 'D' }),
        el('b', { text: 'Harness' }),
        el('span', { class: 'meta escribiendo', text: 'escribiendo…' }),
      ]),
      el('div', { class: 'cuerpo-texto' }, [formatear(enVuelo), el('span', { class: 'cursor' })]),
    ]))
    pintados++
  }

  if (!pintados) interior.append(el('div', { class: 'vacio', text: 'Conversación vacía.' }))
  hilo.append(interior)
  hilo.scrollTop = hilo.scrollHeight

  const sesion = estado.sesiones.find((s) => s.sessionId === estado.actual)
  $('conv-titulo').textContent = sesion ? tituloDe(sesion) : 'Conversación'
  $('conv-hora').textContent = sesion ? hora(sesion.updatedAt) : ''
  const tk = miles(tokensDe(sesion))
  $('tokens-sesion').textContent = tk ? `${tk} tokens` : ''
}

// ── acciones ─────────────────────────────────────────────────────────────

async function abrir(sessionId) {
  estado.actual = sessionId
  pintarLista()
  try {
    estado.historia = await rpc('session.history', { sessionId })
  } catch (error) {
    estado.historia = null
    console.warn(error)
  }
  pintarHilo()
  pintarEntregables()
  pintarEnUso().catch((e) => console.warn(e))
}

async function refrescar() {
  try {
    const [host, sesiones, espacios] = await Promise.all([
      rpc('host.describe'),
      rpc('session.list'),
      rpc('workspace.list').catch(() => ({ items: [] })),
    ])
    estado.host = host
    estado.sesiones = sesiones.items ?? []
    estado.espacios = espacios.items ?? []
    // Archivar no borra la fila de session.list: el harness lleva la cuenta
    // aparte, en workspace.list. Sin esto, lo borrado sigue en la barra.
    estado.archivadas = new Set(espacios.archivedSessionIds ?? [])
  } catch (error) {
    console.warn('no he podido hablar con el harness:', error)
    return
  }
  pintarBarra()
  pintarLista()
  pintarControl()
}

async function contarSkills() {
  if (!estado.actual) return
  try {
    const r = await rpc('skill.list', { sessionId: estado.actual })
    $('n-skills').textContent = String((r.items ?? r.skills ?? []).length)
  } catch { /* la sesión puede no admitirlo todavía */ }
}


// ── escribir ─────────────────────────────────────────────────────────────
//
// session.prompt admite dos modos: "queue" encola el mensaje para el próximo
// turno, "steer" interrumpe el que está corriendo. Aquí encolamos salvo que la
// sesión esté trabajando, en cuyo caso dirigimos.

const caja = $('caja-texto')

function crecerCaja() {
  caja.style.height = 'auto'
  caja.style.height = Math.min(caja.scrollHeight, window.innerHeight * 0.4) + 'px'
}

async function enviar() {
  const texto = caja.value.trim()
  if (!texto || estado.enviando) return

  if (!estado.actual) {
    await nuevaConversacion()
    if (!estado.actual) return
  }

  const sesion = estado.sesiones.find((s) => s.sessionId === estado.actual)
  const modo = sesion?.running ? 'steer' : 'queue'

  estado.enviando = true
  document.querySelector('.caja').classList.add('enviando')

  try {
    await rpc('session.prompt', {
      sessionId: estado.actual,
      mode: modo,
      content: [{ type: 'text', text: texto }],
    })
    caja.value = ''
    crecerCaja()
    // Pintar la respuesta según llega: mientras haya turno vivo, refresco corto.
    seguirDeCerca()
  } catch (error) {
    avisar(`No he podido enviarlo: ${error.message}`)
  } finally {
    estado.enviando = false
    document.querySelector('.caja').classList.remove('enviando')
    caja.focus()
  }
}

let seguimiento = null

function seguirDeCerca() {
  if (seguimiento) clearInterval(seguimiento)
  let vueltas = 0
  seguimiento = setInterval(async () => {
    vueltas++
    await refrescar()
    if (estado.actual) {
      try {
        estado.historia = await rpc('session.history', { sessionId: estado.actual })
        pintarHilo()
        pintarEntregables()
      } catch { /* la siguiente vuelta lo reintenta */ }
    }
    const sesion = estado.sesiones.find((s) => s.sessionId === estado.actual)
    // Para cuando deje de trabajar, o a los cinco minutos por si acaso.
    if ((!sesion?.running && vueltas > 3) || vueltas > 250) {
      clearInterval(seguimiento)
      seguimiento = null
    }
  }, 1200)
}

function avisar(mensaje) {
  const hilo = $('hilo')
  const nota = el('div', { class: 'aviso', text: mensaje })
  hilo.append(nota)
  setTimeout(() => nota.remove(), 6000)
}

async function nuevaConversacion() {
  try {
    const creada = await rpc('session.create', {})
    const id = creada.sessionId ?? creada.id
    await refrescar()
    if (id) await abrir(id)
  } catch (error) {
    avisar(`No he podido crear la conversación: ${error.message}`)
  }
}

caja.addEventListener('input', crecerCaja)
caja.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    enviar()
  }
})
$('enviar').addEventListener('click', enviar)
$('nueva').addEventListener('click', nuevaConversacion)



// ── qué está usando ──────────────────────────────────────────────────────
//
// Tres fuentes distintas:
//   skill.list { sessionId }              → las skills que ve esta conversación
//   subagent.list { parentSessionId }     → los subagentes que ha lanzado
//   pluginInventory/list { args:{} }      → los plugins cargados en el harness
//
// Los plugins vienen con envoltorio `args`, que es otro estilo de llamada del
// mismo gateway; sin él contesta que falta el campo.

async function pintarEnUso() {
  const cuerpo = $('enuso')
  if (!estado.actual) {
    cuerpo.replaceChildren(el('div', { class: 'nada', text: 'Abre una conversación.' }))
    return
  }

  const [skills, subagentes, plugins] = await Promise.all([
    rpc('skill.list', { sessionId: estado.actual }).catch(() => null),
    rpc('subagent.list', { parentSessionId: estado.actual }).catch(() => null),
    rpc('pluginInventory/list', { args: {} }).catch(() => null),
  ])

  const piezas = []

  // skill.list solo responde si la conversación está adjunta al harness; una
  // sesión fría contesta "not attached". En ese caso caemos a nuestra propia
  // lectura de la carpeta, que siempre funciona, y lo decimos.
  let listaSkills = skills?.skills ?? []
  let desdeDisco = false
  if (!listaSkills.length) {
    try {
      const propias = await nuestraApi('skills')
      listaSkills = (propias.activas ?? []).filter((k) => k.valida).map((k) => ({ name: k.nombre, description: k.descripcion }))
      desdeDisco = listaSkills.length > 0
    } catch { /* nos quedamos sin lista */ }
  }

  piezas.push(el('div', { class: 'bloque-uso' }, [
    el('h6', {}, [
      document.createTextNode('Skills'),
      el('em', { text: String(listaSkills.length) }),
      desdeDisco ? el('em', { text: '· instaladas' }) : null,
    ]),
    listaSkills.length
      ? el('div', { class: 'fichas' }, listaSkills.map((k) => el('span', { class: 'ficha', title: k.description ?? '', text: k.name })))
      : el('div', { class: 'nada', text: 'Ninguna disponible.' }),
  ]))

  const entradas = subagentes?.entries ?? []
  piezas.push(el('div', { class: 'bloque-uso' }, [
    el('h6', {}, [document.createTextNode('Subagentes'), el('em', { text: String(entradas.length) })]),
    entradas.length
      ? el('div', { class: 'fichas' }, entradas.map((a) => el('span', {
          class: `ficha${a.running || a.status === 'running' ? ' viva' : ''}`,
          text: a.title ?? a.name ?? a.sessionId ?? 'subagente',
        })))
      : el('div', { class: 'nada', text: 'Ninguno lanzado en esta conversación.' }),
  ]))

  const todos = plugins?.entries ?? []
  const activos = todos.filter((p) => p.enabled && p.fiberPhase === 'active')
  // De 167 filas, las interesantes son las que no vienen de fábrica.
  const ajenos = activos.filter((p) => !String(p.moduleName).startsWith('@deepseek-ai/') && !String(p.moduleName).startsWith('cordis:'))
  piezas.push(el('div', { class: 'bloque-uso' }, [
    el('h6', {}, [document.createTextNode('Plugins'), el('em', { text: `${activos.length} activos de ${todos.length}` })]),
    ajenos.length
      ? el('div', { class: 'fichas' }, ajenos.map((p) => el('span', { class: 'ficha propia', text: p.moduleName })))
      : el('div', { class: 'nada', text: 'Todos son los de fábrica.' }),
  ]))

  $('n-enuso').textContent = `${listaSkills.length} · ${activos.length}`
  cuerpo.replaceChildren(...piezas)
}



// ── diálogos ─────────────────────────────────────────────────────────────
//
// Nada de confirm() ni prompt(): una WKWebView sin delegado de UI —la nuestra—
// los ignora y devuelve false, así que el botón de borrar no haría nada dentro
// de la app aunque funcione en el navegador.

function preguntar({ titulo, texto, confirmar = 'Sí', peligro = false, valor = null }) {
  return new Promise((resolve) => {
    const velo_ = el('div', { class: 'velo' })
    const entrada = valor === null ? null : el('input', { class: 'filtro-modelo', type: 'text', value: valor })

    const cerrar = (respuesta) => { velo_.remove(); resolve(respuesta) }

    const caja = el('div', { class: 'modal dialogo' }, [
      el('header', {}, [el('strong', { text: titulo })]),
      el('div', { class: 'modal-cuerpo' }, [
        el('div', { class: 'texto-dialogo', text: texto }),
        entrada,
      ]),
      el('footer', {}, [
        el('span', { class: 'crece' }),
        el('button', { class: 'boton', text: 'Cancelar', onclick: () => cerrar(null) }),
        el('button', {
          class: `boton ${peligro ? 'peligro' : ''}`,
          text: confirmar,
          onclick: () => cerrar(entrada ? entrada.value.trim() : true),
        }),
      ]),
    ])

    velo_.append(caja)
    velo_.addEventListener('click', (e) => { if (e.target === velo_) cerrar(null) })
    document.body.append(velo_)
    ;(entrada ?? caja.querySelector('footer .boton:last-child')).focus()
    entrada?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cerrar(entrada.value.trim())
      if (e.key === 'Escape') cerrar(null)
    })
  })
}

// ── borrar ───────────────────────────────────────────────────────────────
//
// El harness archiva conversaciones con workspace.archiveSession y borra
// proyectos enteros con workspace.delete. No hay papelera: archivar la saca de
// la lista, borrar el proyecto se lleva su sitio en el registro.

async function borrarConversacion(sesion) {
  const nombre = tituloDe(sesion)
  const vale = await preguntar({
    titulo: 'Borrar conversación',
    texto: `«${nombre}» se quita de la lista y no hay deshacer.`,
    confirmar: 'Borrar',
    peligro: true,
  })
  if (!vale) return
  try {
    await rpc('workspace.archiveSession', { sessionId: sesion.sessionId })
    if (estado.actual === sesion.sessionId) {
      estado.actual = null
      estado.historia = null
      pintarHilo()
    }
    await refrescar()
  } catch (error) {
    avisar(`No he podido borrarla: ${error.message}`)
  }
}

async function bloqueProyectos() {
  const caja = el('div', { class: 'grupo-ajuste' })
  caja.append(el('h5', { text: 'Proyectos' }))

  let lista = []
  try {
    lista = (await rpc('workspace.list')).items ?? []
  } catch (error) {
    caja.append(el('div', { class: 'nada', text: 'No he podido leerlos: ' + error.message }))
    return caja
  }

  if (!lista.length) {
    caja.append(el('div', { class: 'nada', text: 'Todavía no hay proyectos.' }))
    return caja
  }

  for (const w of lista) {
    const fila = el('div', { class: 'fila-proyecto' }, [
      el('div', { class: 'datos-proyecto' }, [
        el('strong', { text: w.title ?? w.path }),
        el('small', { class: 'mono', text: `${w.path} · ${(w.sessionIds ?? []).length} conversaciones` }),
      ]),
      el('button', {
        class: 'boton',
        text: 'Renombrar',
        onclick: async () => {
          const titulo = await preguntar({
            titulo: 'Renombrar proyecto',
            texto: 'Cómo quieres que se llame:',
            confirmar: 'Guardar',
            valor: w.title ?? '',
          })
          if (!titulo) return
          try {
            await rpc('workspace.rename', { workspaceId: w.workspaceId, title: titulo })
            abrirAjustes()
          } catch (error) { avisar(error.message) }
        },
      }),
      el('button', {
        class: 'boton peligro',
        text: 'Borrar',
        onclick: async () => {
          const n = (w.sessionIds ?? []).length
          const vale = await preguntar({
            titulo: 'Borrar proyecto',
            texto: `«${w.title}» se lleva por delante sus ${n} conversaciones. No hay deshacer.`,
            confirmar: 'Borrar el proyecto',
            peligro: true,
          })
          if (!vale) return
          try {
            await rpc('workspace.delete', { workspaceId: w.workspaceId })
            await refrescar()
            abrirAjustes()
          } catch (error) { avisar(error.message) }
        },
      }),
    ])
    caja.append(fila)
  }

  return caja
}

// ── modelo ───────────────────────────────────────────────────────────────
//
// session.models devuelve { current:{provider,model}, groups:[{id,name,models}] }
// y session.selectModel cambia el de la sesión con { sessionId, provider, model }.
// El modelo es por sesión, no global: cambiarlo aquí afecta a la conversación
// abierta, y las nuevas nacen con el que el harness tenga por defecto.

const menuModelos = $('menu-modelos')

async function abrirModelos() {
  if (!menuModelos.classList.contains('oculto')) return cerrarModelos()
  if (!estado.actual) return avisar('Abre una conversación para elegir su modelo.')

  menuModelos.replaceChildren(el('div', { class: 'nada', text: 'Cargando…' }))
  menuModelos.classList.remove('oculto')
  $('modelo').setAttribute('aria-expanded', 'true')

  let datos
  try {
    datos = await rpc('session.models', { sessionId: estado.actual })
  } catch (error) {
    menuModelos.replaceChildren(el('div', { class: 'nada', text: 'No he podido leer los modelos: ' + error.message }))
    return
  }

  const actual = datos.current ?? {}
  const grupos = (datos.groups ?? []).filter((g) => g.models?.length)

  // Con proveedores como OpenRouter la lista pasa de cien: sin filtro no sirve.
  const filtro = el('input', { class: 'filtro-modelo', type: 'search', placeholder: 'Filtrar modelos…', autocomplete: 'off' })
  const contenedor = el('div', { class: 'opciones-modelo' })

  const pintar = () => {
    const q = filtro.value.trim().toLowerCase()
    const piezas = []
    let total = 0
    for (const grupo of grupos) {
      const modelos = q
        ? grupo.models.filter((m) => `${m.name ?? ''} ${m.id}`.toLowerCase().includes(q))
        : grupo.models
      if (!modelos.length) continue
      piezas.push(el('h6', { text: grupo.name ?? grupo.id }))
      for (const modelo of modelos) {
        total++
        const esActual = grupo.id === actual.provider && modelo.id === actual.model
        piezas.push(el('button', {
          class: `opcion-modelo${esActual ? ' actual' : ''}`,
          role: 'option',
          onclick: () => elegirModelo(grupo.id, modelo.id),
        }, [
          el('span', { class: 'tic', text: '✓' }),
          el('span', { text: modelo.name ?? modelo.id }),
          el('span', { class: 'id', text: modelo.id }),
        ]))
      }
    }
    if (!total) piezas.push(el('div', { class: 'nada', text: q ? 'Ningún modelo coincide.' : 'Este harness no ofrece otros modelos.' }))
    contenedor.replaceChildren(...piezas)
  }

  filtro.addEventListener('input', pintar)
  filtro.addEventListener('click', (e) => e.stopPropagation())
  pintar()
  menuModelos.replaceChildren(filtro, contenedor)
  filtro.focus()
}

function cerrarModelos() {
  menuModelos.classList.add('oculto')
  $('modelo').setAttribute('aria-expanded', 'false')
}

async function elegirModelo(provider, model) {
  cerrarModelos()
  try {
    await rpc('session.selectModel', { sessionId: estado.actual, provider, model })
    $('modelo').textContent = model
    await refrescar()
  } catch (error) {
    avisar(`No he podido cambiar el modelo: ${error.message}`)
  }
}

$('modelo').addEventListener('click', (e) => { e.stopPropagation(); abrirModelos() })
document.addEventListener('click', (e) => {
  if (!menuModelos.contains(e.target)) cerrarModelos()
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarModelos() })


// ── esfuerzo de razonamiento ─────────────────────────────────────────────
//
// Va en el mismo session.selectModel, campo `reasoningEffort`, y el servidor lo
// valida contra los esfuerzos que declare ese modelo. Ojo: la API no devuelve
// cuál está puesto ahora mismo, así que recordamos el último que fijamos —por
// sesión y modelo— y, si no sabemos, decimos «por defecto» en vez de inventar.

const menuEsfuerzo = $('menu-esfuerzo')

const claveEsfuerzo = (sessionId, model) => `deepharn:esfuerzo:${sessionId}:${model}`

function esfuerzoRecordado(sessionId, model) {
  try { return localStorage.getItem(claveEsfuerzo(sessionId, model)) ?? null } catch { return null }
}

function recordarEsfuerzo(sessionId, model, effort) {
  try {
    if (effort) localStorage.setItem(claveEsfuerzo(sessionId, model), effort)
    else localStorage.removeItem(claveEsfuerzo(sessionId, model))
  } catch { /* modo privado: nos quedamos sin memoria, no pasa nada */ }
}

async function abrirEsfuerzo() {
  if (!menuEsfuerzo.classList.contains('oculto')) return cerrarEsfuerzo()
  if (!estado.actual) return avisar('Abre una conversación para ajustar su esfuerzo.')

  menuEsfuerzo.replaceChildren(el('div', { class: 'nada', text: 'Cargando…' }))
  menuEsfuerzo.classList.remove('oculto')
  $('esfuerzo').setAttribute('aria-expanded', 'true')

  let datos
  try {
    datos = await rpc('session.models', { sessionId: estado.actual })
  } catch (error) {
    menuEsfuerzo.replaceChildren(el('div', { class: 'nada', text: 'No he podido leerlo: ' + error.message }))
    return
  }

  const actual = datos.current ?? {}
  const grupo = (datos.groups ?? []).find((g) => g.id === actual.provider)
  const modelo = grupo?.models?.find((m) => m.id === actual.model)
  const niveles = modelo?.reasoning?.efforts ?? []

  if (!niveles.length) {
    menuEsfuerzo.replaceChildren(el('div', { class: 'nada', text: 'Este modelo no ofrece niveles de razonamiento.' }))
    return
  }

  const puesto = esfuerzoRecordado(estado.actual, actual.model)
  const piezas = [el('h6', { text: 'Esfuerzo de razonamiento' })]

  const opcion = (id, nombre) => el('button', {
    class: `opcion-modelo${puesto === id ? ' actual' : ''}`,
    role: 'option',
    onclick: () => elegirEsfuerzo(actual.provider, actual.model, id),
  }, [
    el('span', { class: 'tic', text: '✓' }),
    el('span', { text: nombre }),
  ])

  piezas.push(opcion(null, 'Por defecto del proveedor'))
  for (const nivel of niveles) piezas.push(opcion(nivel.id, nivel.name ?? nivel.id))

  menuEsfuerzo.replaceChildren(...piezas)
}

function cerrarEsfuerzo() {
  menuEsfuerzo.classList.add('oculto')
  $('esfuerzo').setAttribute('aria-expanded', 'false')
}

async function elegirEsfuerzo(provider, model, effort) {
  cerrarEsfuerzo()
  try {
    await rpc('session.selectModel', {
      sessionId: estado.actual,
      provider,
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
    })
    recordarEsfuerzo(estado.actual, model, effort)
    pintarEsfuerzo()
  } catch (error) {
    avisar(`No he podido cambiar el esfuerzo: ${error.message}`)
  }
}

function pintarEsfuerzo() {
  const sesion = estado.sesiones.find((s) => s.sessionId === estado.actual)
  const model = valores(sesion)?.model ?? estado.host?.model
  const puesto = estado.actual && model ? esfuerzoRecordado(estado.actual, model) : null
  $('esfuerzo').textContent = puesto ? `Esfuerzo: ${puesto}` : 'Esfuerzo'
}

$('esfuerzo').addEventListener('click', (e) => { e.stopPropagation(); abrirEsfuerzo() })
document.addEventListener('click', (e) => { if (!menuEsfuerzo.contains(e.target)) cerrarEsfuerzo() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarEsfuerzo() })

// ── ajustes ──────────────────────────────────────────────────────────────

const velo = $('velo')

function dato(clave, valor) {
  return el('div', { class: 'dato' }, [el('dt', { text: clave }), el('dd', { text: String(valor ?? '—') })])
}

async function abrirAjustes() {
  const cuerpo = $('ajustes-cuerpo')
  cuerpo.replaceChildren(el('div', { class: 'nada', text: 'Cargando…' }))
  velo.classList.remove('oculto')

  const h = estado.host ?? {}
  const bloques = [
    el('div', { class: 'grupo-ajuste' }, [
      el('h5', { text: 'Este harness' }),
      el('div', { class: 'lista-datos' }, [
        dato('Versión', h.version),
        dato('Proveedor', h.provider),
        dato('Modelo', h.model),
        dato('Carpeta', h.cwd),
        dato('Sesiones', h.attachedSessions),
      ]),
    ]),
  ]

  try {
    const prov = await rpc('llm.providers')
    const items = prov.providers ?? prov.items ?? []
    const activos = items.filter((p) => p.active)
    if (items.length) {
      bloques.push(el('div', { class: 'grupo-ajuste' }, [
        el('h5', { text: `Proveedores · ${activos.length} activos de ${items.length}` }),
        el('div', { class: 'lista-datos' }, (activos.length ? activos : items.slice(0, 8)).map((p) =>
          dato(p.displayName ?? p.provider, p.active ? 'activo' : 'sin configurar')
        )),
      ]))
    }
  } catch (error) {
    bloques.push(el('div', { class: 'nada', text: 'No he podido leer los proveedores: ' + error.message }))
  }

  bloques.push(await bloqueProyectos())
  bloques.push(await bloqueSkills())
  bloques.push(await bloquePlugins())

  cuerpo.replaceChildren(...bloques)
}

// ── skills y plugins desde la app ────────────────────────────────────────
//
// Estos no son RPC del harness: son endpoints nuestros bajo /deepharn/api/,
// porque instalar plugins y tocar la carpeta de skills lo hace su CLI, no su API.

const nuestraApi = async (ruta, opciones) => {
  const r = await fetch(`/deepharn/api/${ruta}`, opciones)
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  return j
}

async function bloqueSkills() {
  const caja = el('div', { class: 'grupo-ajuste' })
  caja.append(el('h5', { text: 'Skills' }))

  let datos
  try {
    datos = await nuestraApi('skills')
  } catch (error) {
    caja.append(el('div', { class: 'nada', text: 'No he podido leerlas: ' + error.message }))
    return caja
  }

  caja.append(el('div', { class: 'peq', text: `Carpeta del harness: ${datos.carpeta}` }))

  const fichas = el('div', { class: 'fichas' })
  for (const s of datos.activas) {
    fichas.append(el('span', {
      class: `ficha${s.valida ? '' : ' rota'}`,
      title: s.valida ? (s.descripcion ?? '') : s.problema,
      text: s.valida ? s.nombre : `${s.nombre} ⚠`,
    }))
  }
  caja.append(fichas)

  const rotas = datos.activas.filter((s) => !s.valida)
  for (const s of rotas) {
    caja.append(el('div', { class: 'aviso-linea', text: `${s.nombre}: ${s.problema}` }))
  }

  if (datos.sueltas.length) {
    caja.append(el('div', { class: 'peq', text: 'Estas están en la carpeta de Claude Code y el harness no las ve:' }))
    const lista = el('div', { class: 'fichas' })
    for (const s of datos.sueltas) {
      lista.append(el('button', {
        class: 'ficha accion',
        onclick: async (e) => {
          e.target.textContent = 'enlazando…'
          try {
            await nuestraApi('skills/enlazar', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ nombre: s.nombre }),
            })
            abrirAjustes()
          } catch (error) { e.target.textContent = error.message }
        },
        text: `+ ${s.nombre}`,
      }))
    }
    caja.append(lista)
  }

  caja.append(el('div', { class: 'peq', text: 'El catálogo se lee al arrancar: reinicia Deepharn para que una skill nueva cuente.' }))
  return caja
}

async function bloquePlugins() {
  const caja = el('div', { class: 'grupo-ajuste' })
  caja.append(el('h5', { text: 'Plugins' }))

  const entrada = el('input', { class: 'filtro-modelo', type: 'text', placeholder: 'paquete npm, ruta o github:usuario/repo', autocomplete: 'off' })
  const boton = el('button', { class: 'boton', text: 'Instalar' })
  const estado_ = el('div', { class: 'peq' })

  boton.addEventListener('click', async () => {
    const paquete = entrada.value.trim()
    if (!paquete) return
    boton.disabled = true
    estado_.textContent = 'Instalando… esto puede tardar un poco.'
    try {
      const r = await nuestraApi('plugins/instalar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paquete }),
      })
      estado_.textContent = r.codigo === 0
        ? `Instalado ${r.modulo}. ${r.fila === true ? 'Fila añadida al perfil.' : 'La fila ya estaba.'} Reinicia Deepharn para cargarlo.`
        : `No ha salido bien (código ${r.codigo}): ${String(r.salida).split('\n').slice(-3).join(' ')}`
      entrada.value = ''
    } catch (error) {
      estado_.textContent = error.message
    } finally {
      boton.disabled = false
    }
  })

  caja.append(el('div', { class: 'fila-instalar' }, [entrada, boton]))
  caja.append(estado_)

  try {
    const inv = await rpc('pluginInventory/list', { args: {} })
    const todos = inv.entries ?? []
    const ajenos = todos.filter((p) => p.enabled && !String(p.moduleName).startsWith('@deepseek-ai/') && !String(p.moduleName).startsWith('cordis:'))
    caja.append(el('div', { class: 'peq', text: `${todos.length} filas cargadas; estas no son de fábrica:` }))
    caja.append(el('div', { class: 'fichas' }, ajenos.map((p) => el('span', { class: 'ficha propia', text: p.moduleName }))))
  } catch { /* si falla, el instalador sigue sirviendo */ }

  return caja
}

$('ir-ajustes').addEventListener('click', abrirAjustes)
$('cerrar-ajustes').addEventListener('click', () => velo.classList.add('oculto'))
velo.addEventListener('click', (e) => { if (e.target === velo) velo.classList.add('oculto') })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') velo.classList.add('oculto') })
$('abrir-oficial').addEventListener('click', () => { location.href = '/' })
$('ir-conexiones').addEventListener('click', abrirAjustes)
$('ir-skills').addEventListener('click', abrirAjustes)

// ── plegado ──────────────────────────────────────────────────────────────

const marco = $('marco')
$('plegar-izq').addEventListener('click', () => {
  marco.classList.toggle('sin-izq')
  $('plegar-izq').classList.toggle('activo', !marco.classList.contains('sin-izq'))
})
$('plegar-der').addEventListener('click', () => {
  marco.classList.toggle('sin-der')
  $('plegar-der').classList.toggle('activo', !marco.classList.contains('sin-der'))
})
$('solo-chat').addEventListener('click', () => {
  const soloChat = marco.classList.contains('sin-izq') && marco.classList.contains('sin-der')
  marco.classList.toggle('sin-izq', !soloChat)
  marco.classList.toggle('sin-der', !soloChat)
})
for (const cab of document.querySelectorAll('.panel-cabecera')) {
  cab.addEventListener('click', () => cab.closest('.panel').classList.toggle('plegado'))
}
$('buscar').addEventListener('input', pintarLista)
$('plegar-izq').classList.add('activo')
$('plegar-der').classList.add('activo')

// ── arranque ─────────────────────────────────────────────────────────────

await refrescar()
if (estado.sesiones.length) {
  const ordenadas = [...estado.sesiones]
    .filter((s) => !estado.archivadas.has(s.sessionId))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const reciente = ordenadas.find((s) => !s.blank) ?? ordenadas[0]
  await abrir(reciente.sessionId)
  await contarSkills()
}
setInterval(refrescar, 4000)
