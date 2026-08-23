// Sirve el frontend de Deepharn desde el propio servidor de dsh.
//
// Tiene que ser el mismo origen que /api: el cortafuegos de la API compara el
// Host de cada petición y rechaza lo que venga de otro puerto. Sirviéndolo aquí,
// nuestra página llama a /api sin CORS y sin permisos especiales.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atenderApi } from './api.js'

const AQUI = dirname(fileURLToPath(import.meta.url))
const WEB = join(AQUI, '..', 'web')

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export const name = 'deepharn-front'
export const inject = ['webServer']

export function apply(ctx) {
  const servir = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let rel = decodeURIComponent(url.pathname).replace(/^\/deepharn\/?/, '')

      // Endpoints propios antes de servir archivos.
      if (rel.startsWith('api/')) {
        const atendido = await atenderApi(req, res, rel)
        if (atendido !== false) return
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no existe"}')
        return
      }

      if (rel === '' || rel.endsWith('/')) rel += 'index.html'

      // Nada de subir por encima de web/.
      const destino = join(WEB, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
      if (!destino.startsWith(WEB)) {
        res.writeHead(403).end('prohibido')
        return
      }

      const info = await stat(destino).catch(() => undefined)
      if (!info?.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('no encontrado')
        return
      }

      res.writeHead(200, {
        'content-type': TIPOS[extname(destino)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      createReadStream(destino).pipe(res)
    } catch (error) {
      ctx.logger?.warn?.(error)
      if (!res.headersSent) res.writeHead(500).end('error')
      else res.end()
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/deepharn',
    handler: servir,
  }), 'deepharn-front: ruta /deepharn')
}
