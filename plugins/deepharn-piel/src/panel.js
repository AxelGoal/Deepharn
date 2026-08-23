// Panel «Sala de control» de Deepharn.
//
// Se registra en shell.overlay, el único hueco del armazón que admite añadidos
// de terceros (kind: list). Los otros — sidebar, conversation, details — son de
// plaza única y ya tienen dueño.
//
// Los campos que lee salen de la instantánea real de ctx.sessions.list:
//   ids, byId{ id, displayTitle, running, blank, updatedAt, cwd,
//              projectionValues{ tokenUsage, sessionStats, todos, goal } },
//   current, jobsBySession

function crearPanel(require, ctx) {
	const react = require("react");
	const jsxRuntime = require("react/jsx-runtime");
	const jsx = jsxRuntime.jsx;
	const jsxs = jsxRuntime.jsxs;

	const T = {
		fondo: "var(--dsw-alias-bg-layer-1)",
		linea: "var(--dsw-alias-border-l2)",
		lineaSuave: "var(--dsw-alias-border-l1)",
		texto: "var(--dsw-alias-label-primary)",
		texto2: "var(--dsw-alias-label-secondary)",
		texto3: "var(--dsw-alias-label-tertiary)",
		marca: "var(--dsw-alias-brand-primary)",
		ambar: "#C58A2E",
	};

	const mono = '"IBM Plex Mono", ui-monospace, Menlo, monospace';

	function usarInstantanea() {
		const fuente = ctx.sessions && ctx.sessions.list;

		const suscribir = react.useCallback((avisar) => {
			if (fuente && typeof fuente.subscribe === "function") return fuente.subscribe(avisar);
			const t = window.setInterval(avisar, 2000);
			return () => window.clearInterval(t);
		}, [fuente]);

		const leer = react.useCallback(() => {
			try {
				return fuente && typeof fuente.getSnapshot === "function" ? fuente.getSnapshot() : null;
			} catch (e) {
				return null;
			}
		}, [fuente]);

		return react.useSyncExternalStore(suscribir, leer, leer);
	}

	function hora(ms) {
		if (!Number.isFinite(ms)) return "";
		const d = new Date(ms);
		const hoy = new Date();
		if (d.toDateString() === hoy.toDateString()) {
			return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
		}
		return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
	}

	function miles(n) {
		if (!Number.isFinite(n) || n === 0) return "0";
		if (n < 1000) return String(n);
		return (n / 1000).toFixed(1).replace(".", ",") + "k";
	}

	function tokensDe(sesion) {
		const u = sesion.projectionValues && sesion.projectionValues.tokenUsage;
		if (!u) return 0;
		return (u.uncachedInputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
	}

	function Fila({ sesion, actual, trabajos }) {
		const viva = sesion.running === true;
		const tokens = tokensDe(sesion);
		return jsxs("div", {
			style: {
				display: "flex", gap: "9px", padding: "7px 10px", borderRadius: "8px",
				alignItems: "flex-start",
				background: actual ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
			},
			children: [
				jsx("span", {
					style: {
						width: "7px", height: "7px", borderRadius: "50%", marginTop: "6px", flex: "none",
						background: viva ? T.ambar : T.linea,
					},
				}),
				jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: 1 },
					children: [
						jsx("span", {
							style: {
								fontSize: "13px", color: T.texto, whiteSpace: "nowrap",
								overflow: "hidden", textOverflow: "ellipsis",
								fontWeight: actual ? 600 : 400,
							},
							children: String(sesion.displayTitle || sesion.id),
						}),
						jsxs("span", {
							style: { fontSize: "11px", color: T.texto3, fontFamily: mono, display: "flex", gap: "8px" },
							children: [
								hora(sesion.updatedAt),
								tokens > 0 ? jsx("span", { children: miles(tokens) + " tk" }) : null,
								trabajos > 0 ? jsx("span", { style: { color: T.ambar }, children: trabajos + " en curso" }) : null,
							],
						}),
					],
				}),
			],
		});
	}

	function Grupo({ titulo, sesiones, actual, jobs, resalte }) {
		if (sesiones.length === 0) return null;
		return jsxs("div", {
			style: { display: "flex", flexDirection: "column", gap: "1px" },
			children: [
				jsxs("div", {
					style: {
						display: "flex", alignItems: "center", gap: "7px", padding: "0 10px 5px",
						fontSize: "10.5px", fontWeight: 700, letterSpacing: ".09em",
						textTransform: "uppercase", color: resalte ? T.ambar : T.texto3,
					},
					children: [titulo, jsx("span", { style: { fontWeight: 500, opacity: .8 }, children: String(sesiones.length) })],
				}),
				...sesiones.slice(0, 10).map((s) => jsx(Fila, {
					sesion: s,
					actual: s.id === actual,
					trabajos: (jobs && jobs[s.id] ? jobs[s.id].length : 0) || 0,
				}, s.id)),
			],
		});
	}

	return function SalaDeControl() {
		const [abierto, setAbierto] = react.useState(true);
		const snapshot = usarInstantanea();

		const sesiones = (snapshot && Array.isArray(snapshot.ids))
			? snapshot.ids.map((id) => snapshot.byId && snapshot.byId[id]).filter(Boolean)
			: [];
		const actual = snapshot && snapshot.current;
		const jobs = (snapshot && snapshot.jobsBySession) || {};

		const inicioDeHoy = new Date().setHours(0, 0, 0, 0);
		const g = { marcha: [], hoy: [], antes: [] };
		for (const s of sesiones) {
			const conTrabajo = jobs[s.id] && jobs[s.id].length > 0;
			if (s.running === true || conTrabajo) g.marcha.push(s);
			else if (Number.isFinite(s.updatedAt) && s.updatedAt >= inicioDeHoy) g.hoy.push(s);
			else g.antes.push(s);
		}
		const porFecha = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
		g.marcha.sort(porFecha); g.hoy.sort(porFecha); g.antes.sort(porFecha);

		const enMarcha = g.marcha.length;

		const cabecera = jsxs("div", {
			onClick: () => setAbierto(!abierto),
			style: {
				display: "flex", alignItems: "center", gap: "9px", cursor: "pointer",
				padding: "11px 14px", borderBottom: abierto ? "1px solid " + T.lineaSuave : "none",
			},
			children: [
				enMarcha > 0
					? jsx("span", { style: { width: "7px", height: "7px", borderRadius: "50%", background: T.ambar } })
					: null,
				jsx("span", {
					style: { fontSize: "11px", fontWeight: 700, letterSpacing: ".09em", textTransform: "uppercase", color: T.texto2 },
					children: "Sala de control",
				}),
				jsx("span", { style: { flex: 1 } }),
				jsx("span", {
					style: { fontSize: "11px", color: T.texto3, fontFamily: mono },
					children: enMarcha > 0 ? enMarcha + " en curso" : String(sesiones.length),
				}),
				jsx("span", { style: { fontSize: "10px", color: T.texto3 }, children: abierto ? "▾" : "▸" }),
			],
		});

		const cuerpo = abierto ? jsxs("div", {
			style: {
				display: "flex", flexDirection: "column", gap: "13px",
				padding: "11px 5px", overflowY: "auto", maxHeight: "62vh",
			},
			children: [
				jsx(Grupo, { titulo: "En marcha", sesiones: g.marcha, actual, jobs, resalte: true }),
				jsx(Grupo, { titulo: "Hoy", sesiones: g.hoy, actual, jobs, resalte: false }),
				jsx(Grupo, { titulo: "Antes", sesiones: g.antes, actual, jobs, resalte: false }),
				sesiones.length === 0
					? jsx("div", {
						style: { padding: "8px 12px", fontSize: "12.5px", color: T.texto3 },
						children: "Todavía no hay conversaciones.",
					})
					: null,
			],
		}) : null;

		return jsxs("div", {
			style: {
				position: "fixed", top: "68px", right: "16px", width: "302px", zIndex: 40,
				background: T.fondo, border: "1px solid " + T.linea, borderRadius: "12px",
				boxShadow: "0 2px 4px rgba(0,0,0,.18), 0 18px 40px -24px rgba(0,0,0,.55)",
				fontFamily: "Figtree, -apple-system, system-ui, sans-serif",
				overflow: "hidden",
			},
			children: [cabecera, cuerpo],
		});
	};
}
