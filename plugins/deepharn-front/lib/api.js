// Endpoints propios de Deepharn, bajo /deepharn/api/.
//
// El harness no expone instalar plugins ni gestionar skills por RPC: eso lo hace
// su CLI. Así que lo hacemos aquí, en la mitad de host, que sí puede tocar disco
// y lanzar procesos. Todo esto solo escucha en 127.0.0.1.

import { spawn } from 'node:child_process'
import { readFile, writeFile, readdir, symlink, lstat, realpath } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CASA = homedir()
const SKILLS_AGENTES = join(CASA, '.agents', 'skills')
const SKILLS_CLAUDE = join(CASA, '.claude', 'skills')
const PERFIL = join(CASA, '.dsh', 'profiles', 'deepharn')
const PARCHE = join(PERFIL, 'cordis.patch.yml')

// ── skills ───────────────────────────────────────────────────────────────

/**
 * Lee el frontmatter de una skill y decide si el harness la va a aceptar.
 * La trampa conocida: un ": " dentro de un escalar sin comillas invalida el
 * YAML y dsh se salta el archivo sin decir nada.
 */
async function revisarSkill(base, nombre) {
  const ruta = join(base, nombre, 'SKILL.md')
  if (!existsSync(ruta)) return { nombre, valida: false, problema: 'No tiene SKILL.md' }

  let texto
  try {
    texto = await readFile(ruta, 'utf8')
  } catch {
    return { nombre, valida: false, problema: 'No se puede leer' }
  }

  if (!texto.startsWith('---')) return { nombre, valida: false, problema: 'Sin frontmatter' }
  const fm = texto.split('---')[1] ?? ''
  const lineas = fm.split('\n')

  const campo = (clave) => lineas.find((l) => l.trimStart().startsWith(clave + ':'))
  if (!campo('name')) return { nombre, valida: false, problema: 'Le falta name' }

  const desc = campo('description')
  if (!desc) return { nombre, valida: false, problema: 'Le falta description' }

  const valor = desc.slice(desc.indexOf(':') + 1)
  const plegado = valor.trim().startsWith('>') || valor.trim().startsWith('|')
  if (!plegado && valor.includes(': ')) {
    return {
      nombre,
      valida: false,
      problema: 'La descripción lleva ": " sin comillas: eso rompe el YAML y el harness la ignora. Pásala a bloque plegado (description: >-).',
    }
  }

  const descripcion = plegado
    ? lineas.slice(lineas.indexOf(desc) + 1).map((l) => l.trim()).filter(Boolean).join(' ')
    : valor.trim()

  return { nombre, valida: true, descripcion: descripcion.slice(0, 220) }
}

async function listarSkills() {
  const enHarness = existsSync(SKILLS_AGENTES) ? await readdir(SKILLS_AGENTES) : []
  const enClaude = existsSync(SKILLS_CLAUDE) ? await readdir(SKILLS_CLAUDE) : []

  const activas = []
  for (const nombre of enHarness.filter((n) => !n.startsWith('.'))) {
    const revision = await revisarSkill(SKILLS_AGENTES, nombre)
    let enlace = null
    try {
      const info = await lstat(join(SKILLS_AGENTES, nombre))
      if (info.isSymbolicLink()) enlace = await realpath(join(SKILLS_AGENTES, nombre))
    } catch { /* da igual */ }
    activas.push({ ...revision, enlace })
  }

  const sueltas = []
  for (const nombre of enClaude.filter((n) => !n.startsWith('.') && !enHarness.includes(n))) {
    sueltas.push(await revisarSkill(SKILLS_CLAUDE, nombre))
  }

  return { carpeta: SKILLS_AGENTES, activas, sueltas }
}

async function enlazarSkill(nombre) {
  if (!/^[\w.-]+$/.test(nombre)) throw new Error('Nombre no válido')
  const origen = join(SKILLS_CLAUDE, nombre)
  const destino = join(SKILLS_AGENTES, nombre)
  if (!existsSync(origen)) throw new Error(`No existe ${origen}`)
  if (existsSync(destino)) throw new Error('Ya estaba enlazada')
  await symlink(origen, destino)
  return { enlazada: nombre }
}

// ── plugins ──────────────────────────────────────────────────────────────

function rutaDeDsh() {
  const candidatas = ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh']
  for (const c of candidatas) if (existsSync(c)) return c
  const cache = join(CASA, '.npm', '_npx')
  if (existsSync(cache)) {
    for (const h of readdirSync(cache).sort()) {
      const p = join(cache, h, 'node_modules', '.bin', 'dsh')
      if (existsSync(p)) return p
    }
  }
  return null
}

function ejecutar(comando, argumentos) {
  return new Promise((resolve) => {
    const p = spawn(comando, argumentos, { cwd: PERFIL })
    let salida = ''
    p.stdout.on('data', (d) => { salida += d })
    p.stderr.on('data', (d) => { salida += d })
    p.on('error', (e) => resolve({ codigo: -1, salida: e.message }))
    p.on('close', (codigo) => resolve({ codigo, salida: salida.slice(-4000) }))
  })
}

async function instalarPlugin(paquete) {
  if (typeof paquete !== 'string' || !paquete.trim()) throw new Error('Falta el paquete')
  const limpio = paquete.trim()
  // Un nombre de paquete, una ruta o un github:usuario/repo. Nada de tuberías
  // ni argumentos sueltos: esto acaba en un spawn sin shell, pero mejor cerrarlo.
  if (/[;&|`$(){}<>\s]/.test(limpio)) throw new Error('El nombre lleva caracteres que no acepto')

  const dsh = rutaDeDsh()
  if (!dsh) throw new Error('No encuentro el ejecutable de dsh')

  const resultado = await ejecutar(dsh, ['plugin', '--profile', 'deepharn', 'add', limpio])
  if (resultado.codigo !== 0) return { ...resultado, fila: false }

  // El nombre del módulo tal y como queda en package.json del perfil.
  let modulo = limpio
  try {
    const manifiesto = JSON.parse(await readFile(join(PERFIL, 'package.json'), 'utf8'))
    const claves = Object.keys(manifiesto.dependencies ?? {})
    modulo = claves.find((k) => limpio.includes(k) || k.includes(limpio.split('/').pop())) ?? limpio
  } catch { /* nos quedamos con lo que escribió */ }

  const parche = await readFile(PARCHE, 'utf8')
  if (parche.includes(`name: ${modulo}`)) return { ...resultado, modulo, fila: 'ya estaba' }

  const id = modulo.replace(/[^\w-]/g, '-').replace(/^-+/, '')
  await writeFile(PARCHE, `${parche}\n- insert:\n    - id: ${id}\n      name: ${modulo}\n`)
  return { ...resultado, modulo, fila: true }
}


// ── catálogo real de OpenRouter ──────────────────────────────────────────
//
// El desplegable sale de un catálogo enlatado dentro del plugin del harness,
// congelado en su versión: enseña modelos retirados —elegir uno da 404— y se
// pierde los nuevos. Esto trae la lista de verdad.
//
// Se pide desde aquí, no desde la página, para no depender de CORS.

let cacheModelos = { cuando: 0, lista: [] }

async function modelosDeOpenrouter() {
  const ahora = Date.now()
  if (ahora - cacheModelos.cuando < 10 * 60 * 1000 && cacheModelos.lista.length) return cacheModelos.lista

  const respuesta = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'accept': 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  if (!respuesta.ok) throw new Error(`OpenRouter respondió ${respuesta.status}`)
  const cuerpo = await respuesta.json()

  const lista = (cuerpo.data ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    // La ventana de contexto hace falta para los modelos que el harness no
    // conoce; los que ya conoce heredan la suya y esto no les afecta.
    contextWindow: Number.isInteger(m.context_length) && m.context_length > 0 ? m.context_length : undefined,
    gratis: String(m.id).endsWith(':free'),
  })).filter((m) => m.id)

  cacheModelos = { cuando: ahora, lista }
  return lista
}

// ── enrutado ─────────────────────────────────────────────────────────────

async function cuerpoJson(req) {
  const trozos = []
  for await (const t of req) trozos.push(t)
  if (!trozos.length) return {}
  try { return JSON.parse(Buffer.concat(trozos).toString('utf8')) } catch { return {} }
}

export async function atenderApi(req, res, ruta) {
  const responder = (codigo, valor) => {
    res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(valor))
  }

  try {
    if (ruta === 'api/skills' && req.method === 'GET') return responder(200, await listarSkills())

    if (ruta === 'api/skills/enlazar' && req.method === 'POST') {
      const { nombre } = await cuerpoJson(req)
      return responder(200, await enlazarSkill(nombre))
    }

    if (ruta === 'api/modelos/openrouter' && req.method === 'GET') {
      return responder(200, { modelos: await modelosDeOpenrouter() })
    }

    if (ruta === 'api/plugins/instalar' && req.method === 'POST') {
      const { paquete } = await cuerpoJson(req)
      return responder(200, await instalarPlugin(paquete))
    }

    return false
  } catch (error) {
    responder(400, { error: error.message })
    return true
  }
}
