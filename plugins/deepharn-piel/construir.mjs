// Ensambla lib/client.js a partir de src/.
//
// El cargador de módulos del cliente sirve un único archivo por plugin y su
// `require` solo resuelve dependencias declaradas, no archivos hermanos. Así que
// las fuentes se concatenan aquí en vez de importarse.
//
// Uso: node construir.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const aqui = dirname(fileURLToPath(import.meta.url))
const leer = (p) => readFileSync(join(aqui, p), 'utf8')

const css = leer('src/piel.css')
const panel = leer('src/panel.js')

// El CSS va dentro de un template literal: los backticks y los ${ del contenido
// tienen que escaparse o el módulo entero se rompe en silencio.
const cssSeguro = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const salida = `// GENERADO por construir.mjs — no editar a mano.
// Fuentes: src/piel.css y src/panel.js

window.__ModuleLoader__.load({
	id: "deepharn-piel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const FUENTES = "https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap";

		const PIEL = \`
${cssSeguro}\`;

${panel}

		const inject = ["slots", "sessions"];

		function apply(ctx) {
			// 1. La piel: tokens de color y tipografía.
			const fuentes = document.createElement("link");
			fuentes.rel = "stylesheet";
			fuentes.href = FUENTES;
			fuentes.dataset.deepharn = "fuentes";

			const piel = document.createElement("style");
			piel.dataset.deepharn = "piel";
			piel.textContent = PIEL;

			document.head.append(fuentes, piel);
			ctx.effect(() => () => {
				fuentes.remove();
				piel.remove();
			}, "deepharn: piel");

			// 2. La sala de control, en el único hueco que admite añadidos.
			const SalaDeControl = crearPanel(require, ctx);
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "deepharn-control"
			}, SalaDeControl));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
`

writeFileSync(join(aqui, 'lib/client.js'), salida)
console.log('lib/client.js escrito:', salida.length, 'bytes')
