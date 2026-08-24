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

let firmaLista = null

function pintarLista(forzar = false) {
  const filtro = $('buscar').value.trim().toLowerCase()
  const firma = filtro + '|' + estado.actual + '|' + estado.sesiones
    .map((s) => `${s.sessionId}:${s.updatedAt}:${s.running ? 1 : 0}`).join(',')
  if (!forzar && firma === firmaLista) return
  firmaLista = firma
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

let firmaControl = null

function pintarControl() {
  const vivasFirma = estado.sesiones.filter((s) => s.running && !estado.archivadas.has(s.sessionId))
    .map((s) => `${s.sessionId}:${s.updatedAt}`).join(',')
  if (vivasFirma === firmaControl) return
  firmaControl = vivasFirma

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

function imagenesDe(contenido) {
  if (!Array.isArray(contenido)) return []
  const vistas = new Set()
  return contenido
    .filter((b) => b?.type === 'image' && b.attachment?.attachmentId)
    .map((b) => b.attachment)
    // El mismo adjunto puede venir repetido dentro de un mensaje.
    .filter((a) => (vistas.has(a.attachmentId) ? false : vistas.add(a.attachmentId)))
}

const miniaturas = new Map()

function tirasDeImagenes(adjuntadas) {
  const tira = el('div', { class: 'imagenes-msg' })

  for (const a of adjuntadas) {
    const hueco = el('img', {
      class: 'imagen-msg',
      alt: 'Imagen adjunta',
      title: `${a.mediaType} · ${a.width}×${a.height}`,
      src: miniaturas.get(a.attachmentId) ?? '',
    })
    tira.append(hueco)

    if (!miniaturas.has(a.attachmentId)) {
      // El log guarda el identificador, no los bytes: hay que pedirlos.
      rpc('session.attachment', { sessionId: estado.actual, attachmentId: a.attachmentId })
        .then((r) => {
          const url = `data:${r.attachment?.mediaType ?? a.mediaType};base64,${r.data}`
          miniaturas.set(a.attachmentId, url)
          hueco.src = url
        })
        .catch(() => { hueco.replaceWith(el('span', { class: 'peq', text: 'imagen adjunta' })) })
    }
  }

  return tira
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

// Repintar cuesta poco, pero hacerlo cada segundo tira el hover, la selección
// de texto y la posición. Con una firma barata del contenido, si no ha cambiado
// nada no se toca el DOM.
function firmaHistoria() {
  const ev = estado.historia?.events ?? []
  const ultimo = ev[ev.length - 1]?.event
  return `${estado.actual}|${ev.length}|${ultimo?.seq ?? ''}|${ultimo?.type ?? ''}`
}

let firmaPintada = null

function pintarHilo(forzar = false) {
  const firma = firmaHistoria()
  if (!forzar && firma === firmaPintada) return
  firmaPintada = firma

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
      const imagenes = imagenesDe(ev.data?.content)
      if (!texto && !imagenes.length) continue
      interior.append(el('div', { class: 'msg usuario' }, [
        el('div', { class: 'meta mono', text: hora(ev.time) }),
        el('div', { class: 'burbuja' }, [
          imagenes.length ? tirasDeImagenes(imagenes) : null,
          texto ? el('div', { class: 'cuerpo-texto' }, [formatear(texto)]) : null,
        ]),
      ]))
      pintados++
    }

    // Un turno que acaba en error: el harness lo cuenta y hasta ahora nos lo
    // tragábamos, así que parecía que la app no hacía nada. Modelo caído,
    // clave caducada o cuota agotada entran todos por aquí.
    if (ev.type === 'turn/end' && ev.data?.reason?.kind === 'error') {
      const mensaje = ev.data.reason.error?.message ?? 'El turno terminó con un error.'
      interior.append(el('div', { class: 'msg' }, [
        el('div', { class: 'error-turno' }, [
          el('strong', { text: 'El modelo no ha podido responder' }),
          el('div', { class: 'detalle-error', text: String(mensaje).slice(0, 400) }),
          el('div', { class: 'pista-error', text: 'Si es un 404 o un problema de cuota, prueba con otro modelo desde la pastilla de arriba.' }),
        ]),
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

  // Si estabas leyendo más arriba, no te bajo a la fuerza. Solo sigo el hilo
  // cuando ya estabas al final, que es cuando quieres ver lo que va llegando.
  const alFinal = hilo.scrollHeight - hilo.scrollTop - hilo.clientHeight < 120
  const posicion = hilo.scrollTop
  hilo.append(interior)
  hilo.scrollTop = alFinal ? hilo.scrollHeight : posicion

  const sesion = estado.sesiones.find((s) => s.sessionId === estado.actual)
  $('conv-titulo').textContent = sesion ? tituloDe(sesion) : 'Conversación'
  $('conv-hora').textContent = sesion ? hora(sesion.updatedAt) : ''
  const tk = miles(tokensDe(sesion))
  $('tokens-sesion').textContent = tk ? `${tk} tokens` : ''
}

// ── acciones ─────────────────────────────────────────────────────────────

async function abrir(sessionId) {
  estado.actual = sessionId
  pintarLista(true)
  try {
    estado.historia = await rpc('session.history', { sessionId })
  } catch (error) {
    estado.historia = null
    console.warn(error)
  }
  pintarHilo(true)
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



// ── permisos ─────────────────────────────────────────────────────────────
//
// El harness pide permiso por los WebSocket de bajada: manda un server-request
// con method "approval/requested" y espera un client-response por POST /api/respond
// con el mismo rpcId. No hay método RPC para preguntarle si hay alguno pendiente:
// si no escuchas el socket, el turno se queda esperando para siempre y la app
// parece colgada. Esto es exactamente lo que pasaba antes.

const aprobaciones = new Map()   // approvalId → { rpcId, payload }
const preguntas = new Map()      // rpcId → payload de question/requested

function conectarEventos() {
  for (const ruta of ['events.mux', 'events.host']) {
    let ws
    const abrir = () => {
      try {
        ws = new WebSocket(`ws://${location.host}/api/${ruta}`)
      } catch { return setTimeout(abrir, 3000) }

      ws.onmessage = (e) => {
        let trama
        try { trama = JSON.parse(e.data) } catch { return }
        if (trama?.type !== 'server-request') return
        atenderPeticion(trama)
      }
      // Si se cae, se reintenta: sin este canal no hay permisos.
      ws.onclose = () => setTimeout(abrir, 3000)
      ws.onerror = () => { try { ws.close() } catch {} }
    }
    abrir()
  }
}

function atenderPeticion(trama) {
  const p = trama.payload ?? {}

  // Los eventos de la conversación llegan por aquí en tiempo real. Antes se
  // sacaban sondeando el historial cada segundo y pico; esto es lo mismo pero
  // según ocurre, sin repintar de más.
  if (p.type === 'session/event') {
    if (p.sessionId && p.sessionId !== estado.actual) return
    const evento = p.event ?? p
    if (!evento?.type) return
    estado.historia ??= { events: [] }
    estado.historia.events = [...(estado.historia.events ?? []), { event: evento }]
    pintarHilo()
    if (evento.type === 'turn/end' || evento.type === 'tool/result') {
      pintarEntregables()
      refrescar()
    }
    return
  }

  if (p.type === 'question/requested') {
    preguntas.set(trama.rpcId, p)
    pintarPreguntas()
    return
  }

  if (p.type === 'approval/requested') {
    aprobaciones.set(p.approvalId, { rpcId: trama.rpcId, payload: p })
    pintarAprobaciones()
    // Dentro de la app de escritorio, además, que salte un diálogo del sistema:
    // si estás en otra ventana no te enteras de una tarjeta en la página.
    window.webkit?.messageHandlers?.deepharn?.postMessage({
      tipo: 'permiso',
      id: p.approvalId,
      herramienta: p.toolName ?? 'una herramienta',
      motivo: p.reason ?? 'Sin motivo declarado.',
    })
    return
  }
  if (p.type === 'approval/resolved' || p.type === 'approval/cancelled') {
    aprobaciones.delete(p.approvalId)
    pintarAprobaciones()
  }
}

async function responderAprobacion(approvalId, outcome) {
  const entrada = aprobaciones.get(approvalId)
  if (!entrada) return
  aprobaciones.delete(approvalId)
  pintarAprobaciones()
  try {
    await fetch('/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: entrada.rpcId,
        result: { ok: true, value: { sessionId: entrada.payload.sessionId, approvalId, outcome } },
      }),
    })
    seguirDeCerca()
  } catch (error) {
    avisar(`No he podido responder al permiso: ${error.message}`)
  }
}

// La concha responde por aquí cuando eliges en el diálogo nativo.
window.__responderPermiso = (id, decision) => responderAprobacion(id, decision)

// El agente también puede hacer preguntas con opciones. Van por el mismo canal
// y, si nadie responde, el turno se queda esperando igual que con los permisos.
async function responderPregunta(rpcId, respuestas) {
  const entrada = preguntas.get(rpcId)
  if (!entrada) return
  preguntas.delete(rpcId)
  pintarPreguntas()
  try {
    await fetch('/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId,
        result: { ok: true, value: { sessionId: entrada.sessionId ?? estado.actual, answer: { answers: respuestas } } },
      }),
    })
  } catch (error) {
    avisar(`No he podido responder: ${error.message}`)
  }
}

function pintarPreguntas() {
  const zona = $('preguntas')
  zona.replaceChildren()
  zona.classList.toggle('oculto', preguntas.size === 0)

  for (const [rpcId, p] of preguntas) {
    const lista = Array.isArray(p.questions) ? p.questions : []
    const elegidas = new Map()

    const tarjeta = el('div', { class: 'permiso pregunta' }, [
      el('div', { class: 'permiso-alto' }, [
        el('span', { class: 'permiso-punto' }),
        el('strong', { text: lista.length > 1 ? 'El agente te pregunta' : 'El agente te pregunta una cosa' }),
      ]),
    ])

    lista.forEach((q, i) => {
      const id = q.id ?? String(i)
      const texto = q.question ?? q.header ?? q.text ?? 'Elige una opción'
      const opciones = Array.isArray(q.options) ? q.options : []
      const fila = el('div', { class: 'pregunta-bloque' }, [el('div', { class: 'permiso-motivo', text: texto })])
      const botones = el('div', { class: 'fichas' })
      for (const o of opciones) {
        const etiqueta = typeof o === 'string' ? o : (o.label ?? o.value ?? String(o))
        const boton = el('button', {
          class: 'ficha accion',
          title: typeof o === 'object' ? (o.description ?? '') : '',
          text: etiqueta,
          onclick: () => {
            elegidas.set(id, [etiqueta])
            for (const otro of botones.children) otro.classList.remove('propia')
            boton.classList.add('propia')
          },
        })
        botones.append(boton)
      }
      fila.append(botones)
      tarjeta.append(fila)
    })

    tarjeta.append(el('div', { class: 'permiso-botones' }, [
      el('button', {
        class: 'boton',
        text: 'Responder',
        onclick: () => responderPregunta(rpcId, [...elegidas].map(([id, selected]) => ({ id, selected }))),
      }),
    ]))

    zona.append(tarjeta)
  }
}

function pintarAprobaciones() {
  const zona = $('permisos')
  zona.replaceChildren()
  const pendientes = [...aprobaciones.values()]
  zona.classList.toggle('oculto', pendientes.length === 0)

  for (const { payload: p } of pendientes) {
    zona.append(el('div', { class: 'permiso' }, [
      el('div', { class: 'permiso-alto' }, [
        el('span', { class: 'permiso-punto' }),
        el('strong', { text: `El agente pide permiso para usar ${p.toolName ?? 'una herramienta'}` }),
      ]),
      el('div', { class: 'permiso-motivo', text: p.reason ?? 'Sin motivo declarado.' }),
      el('div', { class: 'permiso-botones' }, [
        el('button', { class: 'boton', text: 'Rechazar', onclick: () => responderAprobacion(p.approvalId, 'rejected') }),
        el('button', { class: 'boton principal', text: 'Permitir una vez', onclick: () => responderAprobacion(p.approvalId, 'allowed-once') }),
      ]),
    ]))
  }
}

conectarEventos()

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
  if ((!texto && !adjuntos.length) || estado.enviando) return

  if (!estado.actual) {
    await nuevaConversacion()
    if (!estado.actual) return
  }

  const sesion = estado.sesiones.find((s) => s.sessionId === estado.actual)
  const modo = sesion?.running ? 'steer' : 'queue'

  estado.enviando = true
  document.querySelector('.caja').classList.add('enviando')

  try {
    // Las imágenes viajan dentro del mensaje; los demás archivos ya están en
    // el espacio de trabajo, así que basta con decirle al agente dónde miran.
    const enDisco = adjuntos.filter((a) => !a.imagen)
    const nota = enDisco.length
      ? (texto ? texto + '\n\n' : '') +
        'Archivos adjuntos, en el espacio de trabajo:\n' +
        enDisco.map((a) => `- ${a.ruta}`).join('\n')
      : texto

    const contenido = [
      ...adjuntos.filter((a) => a.imagen).map((a) => ({ type: 'image', mediaType: a.mediaType, data: a.datos })),
      ...(nota ? [{ type: 'text', text: nota }] : []),
    ]

    await rpc('session.prompt', {
      sessionId: estado.actual,
      mode: modo,
      content: contenido,
    })
    caja.value = ''
    adjuntos.length = 0
    pintarAdjuntos()
    crecerCaja()
    // Pintar la respuesta según llega: mientras haya turno vivo, refresco corto.
    seguirDeCerca()
  } catch (error) {
    if (/does not support image input/i.test(error.message)) {
      // El harness mira su propio registro de modelos, no lo que diga el
      // proveedor. Si el catálogo está viejo, un modelo con visión se rechaza.
      avisar('Este modelo no admite imágenes según el registro del harness. Si sabes que sí las lee, actualiza el catálogo en Ajustes › Modelos y vuelve a intentarlo; si no, elige otro modelo.')
    } else {
      avisar(`No he podido enviarlo: ${error.message}`)
    }
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




// Los cuatro presets de fábrica vienen con nombre y descripción en chino en
// esta versión del harness, y el ajuste de idioma no los cambia. Se traducen
// aquí; los tuyos conservan lo que hayas escrito.
const AGENTES_DE_FABRICA = {
  standard: {
    nombre: 'Estándar',
    descripcion: 'Agente completo: edita archivos, usa la shell, busca en disco y en la web, y maneja skills, planes, objetivos, subagentes y flujos de trabajo.',
  },
  code: {
    nombre: 'Programación (PTC)',
    descripcion: 'Todo lo del estándar, pero las herramientas se le presentan como código: el modelo compone varios pasos en un solo programa TypeScript.',
  },
  minimal: {
    nombre: 'Mínimo',
    descripcion: 'Dos herramientas y nada más: una shell persistente y un editor de texto. Rápido y sin distracciones.',
  },
  cordis: {
    nombre: 'Creación de agentes',
    descripcion: 'Pensado para crear agentes nuevos: todo lo del estándar más inspección en marcha, pruebas de plugins y guía para escribir presets.',
  },
}

// ── agentes ──────────────────────────────────────────────────────────────
//
// Un «agente» aquí es un preset: una composición que decide con qué
// herramientas y con qué personalidad arranca la conversación. Los cuatro que
// trae el harness son de sistema y no se tocan; los tuyos salen de duplicar uno
// y editar el archivo. La API es de solo copia: no acepta contenido, así que
// editar es abrir el documento en tu editor.

async function abrirAgentes() {
  const cuerpo = $('ajustes-cuerpo')
  $('ajustes-titulo').textContent = 'Agentes'
  cuerpo.replaceChildren(el('div', { class: 'nada', text: 'Cargando…' }))
  velo.classList.remove('oculto')

  let presets = []
  let actual = null
  try {
    presets = (await rpc('agentPreset.list')).presets ?? []
    const sesion = estado.sesiones.find((s) => s.sessionId === estado.actual)
    actual = sesion?.agentPreset ?? null
  } catch (error) {
    cuerpo.replaceChildren(el('div', { class: 'nada', text: 'No he podido leerlos: ' + error.message }))
    return
  }

  const piezas = []

  for (const p of presets) {
    const propio = p.trust !== 'system'
    const enUso = p.id === actual

    const acciones = el('div', { class: 'acciones-agente' }, [
      enUso
        ? el('span', { class: 'peq marca-defecto', text: 'en esta conversación' })
        : el('button', {
            class: 'boton',
            text: 'Usar aquí',
            onclick: async () => {
              try {
                await rpc('agentPreset.select', { sessionId: estado.actual, agentPreset: p.id })
                await refrescar()
                abrirAgentes()
              } catch (error) { avisar(error.message) }
            },
          }),
      el('button', {
        class: 'boton',
        text: 'Duplicar',
        onclick: async () => {
          const nombre = await preguntar({
            titulo: 'Duplicar agente',
            texto: `Se crea una copia de «${p.name ?? p.id}» que puedes editar a tu gusto.`,
            confirmar: 'Crear', valor: `${p.id}-mio`,
          })
          if (!nombre) return
          try {
            await rpc('agentPreset.copy', { from: p.id, agentPreset: nombre })
            abrirAgentes()
          } catch (error) { avisar(error.message) }
        },
      }),
    ])

    if (propio) {
      acciones.append(el('button', {
        class: 'boton',
        text: 'Editar',
        onclick: async () => {
          try { await rpc('agentPreset.openDocument', { agentPreset: p.id }) }
          catch (error) { avisar(error.message) }
        },
      }))
      acciones.append(el('button', {
        class: 'boton peligro',
        text: 'Borrar',
        onclick: async () => {
          const vale = await preguntar({
            titulo: 'Borrar agente', texto: `«${p.id}» desaparece. No hay deshacer.`,
            confirmar: 'Borrar', peligro: true,
          })
          if (!vale) return
          try { await rpc('agentPreset.remove', { agentPreset: p.id }); abrirAgentes() }
          catch (error) { avisar(error.message) }
        },
      }))
    }

    const traducido = AGENTES_DE_FABRICA[p.id]
    const titulo = traducido?.nombre ?? p.name ?? p.id
    const descripcion = traducido?.descripcion ?? p.description

    piezas.push(el('div', { class: 'ficha-agente' }, [
      el('div', { class: 'datos-proyecto' }, [
        el('strong', { text: titulo }),
        el('small', { class: 'mono', text: `${p.id} · ${propio ? 'tuyo' : 'de fábrica'}` }),
        descripcion ? el('div', { class: 'peq', text: String(descripcion).slice(0, 200) }) : null,
      ]),
      acciones,
    ]))
  }

  piezas.push(el('div', { class: 'peq', text: 'Los de fábrica no se pueden editar: duplica uno y cambia la copia. El agente elegido solo afecta a esta conversación; las nuevas nacen con el de por defecto.' }))
  cuerpo.replaceChildren(...piezas)
}

// ── conexiones ───────────────────────────────────────────────────────────
//
// Los servidores MCP se declaran como filas del árbol y sus tokens viven en el
// entorno. Esto lo hace por ti: escribe la fila, guarda el token aparte y
// reinicia el harness, que es lo que hace falta para que se conecten.

async function abrirConexiones() {
  const cuerpo = $('ajustes-cuerpo')
  $('ajustes-titulo').textContent = 'Conexiones'
  cuerpo.replaceChildren(el('div', { class: 'nada', text: 'Cargando…' }))
  velo.classList.remove('oculto')

  let datos
  try {
    datos = await nuestraApi('conexiones')
  } catch (error) {
    cuerpo.replaceChildren(el('div', { class: 'nada', text: 'No he podido leerlas: ' + error.message }))
    return
  }

  const piezas = []

  const lista = el('div', { class: 'grupo-ajuste' }, [el('h5', { text: `Conectadas · ${datos.conexiones.length}` })])
  if (!datos.conexiones.length) {
    lista.append(el('div', { class: 'nada', text: 'Todavía no hay ninguna. Añade una abajo.' }))
  } else {
    for (const c of datos.conexiones) {
      lista.append(el('div', { class: 'fila-proyecto' }, [
        el('div', { class: 'datos-proyecto' }, [
          el('strong', { text: c.nombre }),
          el('small', { class: 'mono', text: `${c.transporte} · ${c.destino}${c.variable ? ' · token en .env' : ''}` }),
        ]),
        el('button', {
          class: 'boton peligro',
          text: 'Quitar',
          onclick: async () => {
            const vale = await preguntar({
              titulo: 'Quitar conexión',
              texto: `«${c.nombre}» dejará de estar disponible para el agente. El token, si lo hay, se queda guardado.`,
              confirmar: 'Quitar', peligro: true,
            })
            if (!vale) return
            try {
              await nuestraApi('conexiones/quitar', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ nombre: c.nombre }),
              })
              abrirConexiones()
            } catch (error) { avisar(error.message) }
          },
        }),
      ]))
    }
  }
  piezas.push(lista)

  // Formulario
  const nombre = el('input', { class: 'filtro-modelo', type: 'text', placeholder: 'nombre corto, p. ej. n8n' })
  const tipo = el('select', { class: 'filtro-modelo' })
  tipo.append(el('option', { value: 'stdio', text: 'Programa local (stdio)' }))
  tipo.append(el('option', { value: 'http', text: 'Dirección web (http)' }))
  const destino = el('input', { class: 'filtro-modelo', type: 'text', placeholder: 'npx -y el-paquete-del-servidor' })
  const token = el('input', { class: 'filtro-modelo', type: 'password', placeholder: 'token, si lo necesita (opcional)' })
  const estado_ = el('div', { class: 'peq' })

  tipo.addEventListener('change', () => {
    destino.placeholder = tipo.value === 'stdio' ? 'npx -y el-paquete-del-servidor' : 'https://tu-servidor/mcp'
  })

  const guardar = el('button', { class: 'boton principal', text: 'Añadir' })
  guardar.addEventListener('click', async () => {
    guardar.disabled = true
    estado_.textContent = 'Guardando…'
    try {
      await nuestraApi('conexiones', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nombre: nombre.value, transporte: tipo.value, destino: destino.value, token: token.value }),
      })
      nombre.value = ''; destino.value = ''; token.value = ''
      estado_.textContent = 'Añadida. Hay que reiniciar el harness para que se conecte.'
      setTimeout(abrirConexiones, 1500)
    } catch (error) {
      estado_.textContent = error.message
    } finally { guardar.disabled = false }
  })

  piezas.push(el('div', { class: 'grupo-ajuste' }, [
    el('h5', { text: 'Añadir una' }),
    el('div', { class: 'formulario' }, [nombre, tipo, destino, token, guardar]),
    estado_,
    el('div', { class: 'peq', text: 'El token se guarda en ' + datos.archivoEnv + ', nunca en la configuración.' }),
    el('div', { class: 'peq', text: 'Si el servidor pide entrar con el navegador, autorízalo antes en un terminal: aquí no hay dónde enseñarte el enlace.' }),
  ]))

  piezas.push(el('div', { class: 'grupo-ajuste' }, [
    el('button', {
      class: 'boton',
      text: 'Reiniciar el harness ahora',
      onclick: () => {
        window.webkit?.messageHandlers?.deepharn?.postMessage({ tipo: 'reiniciar' })
        avisar('Reiniciando. Si no ocurre nada, usa ⇧⌘R desde el menú Vista.')
      },
    }),
  ]))

  cuerpo.replaceChildren(...piezas)
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

  const pie = el('div', { class: 'pie-modelos' }, [
    el('span', { class: 'peq', text: `${grupos.reduce((n, g) => n + g.models.length, 0)} modelos` }),
    el('button', {
      class: 'boton',
      text: 'Actualizar desde OpenRouter',
      onclick: async (e) => { e.stopPropagation(); await sincronizarModelos(e.target) },
    }),
  ])

  // Elegir un modelo aquí no afecta solo a esta conversación: el harness lo
  // guarda además como el de las nuevas. Conviene decirlo, porque explica que
  // un gratuito elegido de paso se convierta en el de todos los días.
  const defecto = await modeloPorDefecto()
  const filaDefecto = el('div', { class: 'pie-modelos defecto' }, [
    el('span', {
      class: 'peq',
      text: defecto
        ? `El que elijas queda también para las conversaciones nuevas · ahora: ${defecto.model}`
        : 'El que elijas queda también para las conversaciones nuevas',
    }),
  ])

  menuModelos.replaceChildren(filtro, contenedor, pie, filaDefecto)
  filtro.focus()
}

// El modelo por defecto vive en los ajustes, no en la sesión: es el que
// heredan las conversaciones nuevas. Sin esto había que editar el archivo a
// mano, que es justo lo que el agente intentaba hacer una y otra vez.
async function modeloPorDefecto() {
  try {
    const d = await rpc('settings.describe')
    const ns = (d.namespaces ?? []).find((n) => n.ns === 'agent-default-model')
    return ns?.value ?? null
  } catch { return null }
}

// Trae el catálogo real y lo declara en los ajustes del proveedor. Declarar la
// lista sustituye a la enlatada, pero cada entrada se mezcla sobre la que el
// harness ya conocía: los modelos de siempre conservan sus niveles de
// razonamiento y los nuevos entran con su ventana de contexto.
async function sincronizarModelos(boton) {
  const original = boton.textContent
  boton.textContent = 'Consultando…'
  boton.disabled = true
  try {
    const { modelos } = await nuestraApi('modelos/openrouter')
    const declarados = modelos.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      // Sin declarar la modalidad, el harness supone que el modelo solo lee
      // texto y rechaza cualquier imagen aunque el modelo la admita.
      ...(m.imagen ? { input: ['text', 'image'] } : {}),
    }))
    await rpc('settings.update', {
      ns: 'llm-pi-ai',
      patch: { providers: { openrouter: { models: declarados } } },
    })
    catalogoImagen = null
    const gratis = modelos.filter((m) => m.gratis).length
    boton.textContent = `${modelos.length} modelos (${gratis} gratis)`
    setTimeout(() => { cerrarModelos(); abrirModelos() }, 1200)
  } catch (error) {
    boton.textContent = 'No ha podido: ' + String(error.message).slice(0, 40)
    setTimeout(() => { boton.textContent = original; boton.disabled = false }, 4000)
  }
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
    catalogoImagen = null
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
  $('ajustes-titulo').textContent = 'Ajustes'
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
$('ir-conexiones').addEventListener('click', abrirConexiones)
$('ir-skills').addEventListener('click', abrirAjustes)
$('ir-agentes').addEventListener('click', abrirAgentes)

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
$('buscar').addEventListener('input', () => pintarLista(true))
$('plegar-izq').classList.add('activo')
$('plegar-der').classList.add('activo')


// ── adjuntar ─────────────────────────────────────────────────────────────
//
// El harness solo admite dos tipos de contenido en session.prompt: "text" e
// "image". Así que hay dos caminos:
//
//   · Una imagen (png, jpeg, webp o gif) viaja dentro del mensaje, en base64,
//     y el modelo la ve.
//   · Cualquier otra cosa —un PDF, un csv, un .md— se copia a la carpeta
//     adjuntos/ del espacio de trabajo y en el mensaje va su ruta. El agente
//     tiene herramientas para abrir archivos: se lo decimos y lo lee él.
//
// De cara a ti la diferencia no se nota: eliges el archivo y ya está.

const IMAGENES_QUE_ADMITE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const TOPE_IMAGEN = 6 * 1024 * 1024

// Lo pendiente de enviar: se vacía con cada mensaje.
const adjuntos = []

function pesar(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function leerBase64(archivo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader()
    // El resultado viene como data:<tipo>;base64,<datos>; nos quedamos con los datos.
    lector.onload = () => resolve(String(lector.result).split(',')[1] ?? '')
    lector.onerror = () => reject(new Error('No he podido leer el archivo'))
    lector.readAsDataURL(archivo)
  })
}

function iconoSvg(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'icono-mini')
  svg.setAttribute('viewBox', '0 0 24 24')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', d)
  svg.append(p)
  return svg
}

const ICONO_CARPETA = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
const ICONO_HOJA = 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5'

function pintarAdjuntos() {
  const caja = $('adjuntos')
  caja.textContent = ''
  caja.classList.toggle('oculto', adjuntos.length === 0)

  adjuntos.forEach((a, i) => {
    const quitar = el('button', {
      class: 'adjunto-quitar', text: '✕', title: 'Quitar',
      onclick: () => { adjuntos.splice(i, 1); pintarAdjuntos() },
    })

    caja.append(el('div', { class: 'adjunto' }, [
      a.miniatura ? el('img', { src: a.miniatura, alt: '' }) : iconoSvg(ICONO_HOJA),
      el('div', { class: 'adjunto-datos' }, [
        el('span', { class: 'adjunto-nombre', text: a.nombre, title: a.ruta ?? a.nombre }),
        el('span', { class: 'adjunto-peso', text: a.imagen ? `imagen · ${pesar(a.bytes)}` : `${a.ruta} · ${pesar(a.bytes)}` }),
      ]),
      quitar,
    ]))
  })
}

async function tomarArchivos(lista) {
  for (const archivo of lista) {
    try {
      if (IMAGENES_QUE_ADMITE.has(archivo.type)) {
        if (archivo.size > TOPE_IMAGEN) {
          avisar(`«${archivo.name}» pesa ${pesar(archivo.size)}: para mandarla al modelo tiene que bajar de ${pesar(TOPE_IMAGEN)}.`)
          continue
        }
        const datos = await leerBase64(archivo)
        adjuntos.push({
          nombre: archivo.name, bytes: archivo.size, imagen: true,
          mediaType: archivo.type, datos,
          miniatura: `data:${archivo.type};base64,${datos}`,
        })
      } else {
        // Lo que el modelo no puede mirar, lo dejamos donde el agente sí llega.
        const datos = await leerBase64(archivo)
        const r = await nuestraApi('adjuntos', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nombre: archivo.name, datos }),
        })
        adjuntos.push({ nombre: archivo.name, bytes: r.bytes, imagen: false, ruta: r.ruta })
      }
    } catch (error) {
      avisar(`«${archivo.name}»: ${error.message}`)
    }
  }
  pintarAdjuntos()
  avisarSiElModeloNoVeImagenes()
  caja.focus()
}

// Casi ningún modelo de texto acepta imágenes, y el harness solo lo dice al
// pulsar enviar. Como el catálogo de OpenRouter sí trae la modalidad de
// entrada, lo miramos al adjuntar y avisamos con tiempo.

let catalogoImagen = null

async function avisarSiElModeloNoVeImagenes() {
  if (!adjuntos.some((a) => a.imagen)) return

  const actual = $('modelo').textContent.trim()
  if (!actual || actual === '—') return

  try {
    if (!catalogoImagen) {
      const { modelos } = await nuestraApi('modelos/openrouter')
      catalogoImagen = new Map(modelos.map((m) => [m.id, m.imagen]))
    }
  } catch { return }   // sin catálogo no opinamos: ya avisará el envío

  // Lo que no está en el catálogo no lo juzgamos: callar es mejor que soltar
  // un aviso falso sobre un modelo que no conocemos.
  if (catalogoImagen.get(actual) !== false) return

  avisar(`«${actual}» no lee imágenes. Elige otro modelo en la pastilla de arriba, o quita la imagen y descríbesela.`)
}

$('btn-adjuntar').addEventListener('click', () => $('selector-archivo').click())
$('selector-archivo').addEventListener('change', async (e) => {
  await tomarArchivos([...e.target.files])
  e.target.value = ''   // para que puedas volver a elegir el mismo archivo
})

// Arrastrar y soltar sobre el compositor, y pegar una imagen del portapapeles.
const cajaCompositor = document.querySelector('.caja')
for (const evento of ['dragenter', 'dragover']) {
  cajaCompositor.addEventListener(evento, (e) => { e.preventDefault(); cajaCompositor.classList.add('soltando') })
}
for (const evento of ['dragleave', 'drop']) {
  cajaCompositor.addEventListener(evento, () => cajaCompositor.classList.remove('soltando'))
}
cajaCompositor.addEventListener('drop', (e) => {
  e.preventDefault()
  if (e.dataTransfer?.files?.length) tomarArchivos([...e.dataTransfer.files])
})
caja.addEventListener('paste', (e) => {
  const pegados = [...(e.clipboardData?.items ?? [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean)
  if (pegados.length) { e.preventDefault(); tomarArchivos(pegados) }
})

// ── @ Archivos ───────────────────────────────────────────────────────────
//
// Un paseo por la carpeta del espacio de trabajo para meter una ruta en el
// mensaje sin tener que escribirla. No sube nada: el archivo ya está ahí y el
// agente lo abre cuando le nombras la ruta.

async function abrirArchivos() {
  const velo_ = el('div', { class: 'velo' })
  const cerrar = () => velo_.remove()

  const migas = el('div', { class: 'migas' })
  const lista = el('div', { class: 'lista-archivos' })

  async function ir(sub) {
    lista.textContent = ''
    migas.textContent = ''
    let datos
    try {
      datos = await nuestraApi('archivos?sub=' + encodeURIComponent(sub))
    } catch (error) {
      lista.append(el('div', { class: 'nada', text: 'No he podido leer la carpeta: ' + error.message }))
      return
    }

    // Migas: la raíz y cada tramo del camino, todos pinchables.
    const tramos = datos.sub ? datos.sub.split('/') : []
    migas.append(el('button', { text: datos.raiz.split('/').filter(Boolean).pop() || '/', onclick: () => ir('') }))
    tramos.forEach((t, i) => {
      migas.append(el('span', { text: '/' }))
      migas.append(el('button', { text: t, onclick: () => ir(tramos.slice(0, i + 1).join('/')) }))
    })

    if (datos.sub) {
      lista.append(el('button', { class: 'fila-archivo', onclick: () => ir(tramos.slice(0, -1).join('/')) }, [
        iconoSvg(ICONO_CARPETA), el('span', { text: '..' }),
      ]))
    }

    if (!datos.entradas.length) {
      lista.append(el('div', { class: 'nada', text: 'Esta carpeta está vacía.' }))
      return
    }

    for (const e of datos.entradas) {
      lista.append(el('button', { class: 'fila-archivo', onclick: () => {
        if (e.carpeta) return ir(e.ruta)
        insertarEnCaja('@' + e.ruta + ' ')
        cerrar()
      } }, [
        iconoSvg(e.carpeta ? ICONO_CARPETA : ICONO_HOJA),
        el('span', { text: e.nombre }),
        el('em', { text: e.carpeta ? '' : pesar(e.tamano) }),
      ]))
    }
  }

  velo_.append(el('div', { class: 'modal' }, [
    el('header', {}, [
      el('strong', { text: 'Archivos del espacio de trabajo' }),
      el('span', { class: 'crece' }),
      el('button', { class: 'boton', text: 'Cerrar', onclick: cerrar }),
    ]),
    el('div', { class: 'modal-cuerpo' }, [
      el('div', { class: 'nada', text: 'Elige un archivo y su ruta va al mensaje. El agente lo abre desde ahí.' }),
      migas,
      lista,
    ]),
  ]))

  velo_.addEventListener('click', (e) => { if (e.target === velo_) cerrar() })
  document.body.append(velo_)
  ir('')
}

/** Mete texto donde tengas el cursor, sin pisar lo que ya hubiera escrito. */
function insertarEnCaja(texto) {
  const i = caja.selectionStart ?? caja.value.length
  const j = caja.selectionEnd ?? i
  caja.value = caja.value.slice(0, i) + texto + caja.value.slice(j)
  caja.selectionStart = caja.selectionEnd = i + texto.length
  crecerCaja()
  caja.focus()
}

$('btn-archivos').addEventListener('click', abrirArchivos)

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
setInterval(refrescar, 10000)   // los eventos llegan por WebSocket; esto es solo la red de seguridad
