// Deepharn — concha de escritorio para DeepSeek Harness.
//
// Al abrirla: mira si ya hay un harness sirviendo Deepharn en alguno de sus
// puertos. Si lo hay, se engancha y no toca nada. Si no, lo arranca ella misma y
// espera a que responda. Al salir, para solo el que haya arrancado ella.
//
// La comprobación no es «¿responde el puerto?» sino «¿responde NUESTRO
// frontend?»: así no se cuelga de un harness ajeno que ocupe el 3081 con otro
// perfil.

import AppKit
import WebKit

let puertos = [3081, 3082, 3083]
let perfil = "deepharn"

func urlApp(_ puerto: Int) -> URL { URL(string: "http://127.0.0.1:\(puerto)/deepharn/")! }
func urlSalud(_ puerto: Int) -> URL { URL(string: "http://127.0.0.1:\(puerto)/deepharn/api/skills")! }
func urlOficial(_ puerto: Int) -> URL { URL(string: "http://127.0.0.1:\(puerto)/")! }
/// Dónde abre la app. Desde dsh 0.1.5 su propia interfaz basta y no la tocamos:
/// nuestro frontend sigue servido en /deepharn y se llega desde el menú.
func urlInicio(_ puerto: Int) -> URL { urlOficial(puerto) }
func urlCredencial(_ puerto: Int, _ ficha: String) -> URL { URL(string: "http://127.0.0.1:\(puerto)/?token=\(ficha)")! }

let registro = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Deepharn.log")


// ── Credencial del harness ───────────────────────────────────────────────────
//
// Desde 0.1.5 el harness protege /api con una galleta de sesión. Solo la
// acuña `GET /?token=<ficha>`, y la ficha se imprime al arrancar:
//
//     dsh web: http://127.0.0.1:3081/?token=…
//
// Como la app es quien lanza el proceso, es quien puede leerla. Se carga esa
// URL una vez en la vista web —la galleta va a Path=/, así que vale también
// para /deepharn— y después se entra en nuestro frontend. Sin esto, la página
// carga pero todas las llamadas a /api responden 401.

/// Última ficha impresa en el registro para este puerto, si la hay.
func fichaDelRegistro(_ puerto: Int) -> String? {
    guard let texto = try? String(contentsOf: registro, encoding: .utf8) else { return nil }
    let patron = "127.0.0.1:\(puerto)/?token="
    // De atrás hacia delante: si el harness se ha reiniciado, vale la última.
    guard let rango = texto.range(of: patron, options: .backwards) else { return nil }
    let cola = texto[rango.upperBound...]
    let ficha = cola.prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }
    return ficha.isEmpty ? nil : String(ficha)
}

// ── Cómo lanzar el harness ───────────────────────────────────────────────────

/// Ejecutable y argumentos previos. Prefiere un `dsh` instalado; si no hay,
/// tira de `npx`, que funciona sin instalar nada en global.
func comoLanzar() -> (String, [String])? {
    let fm = FileManager.default

    if let propia = ProcessInfo.processInfo.environment["DEEPHARN_DSH"], fm.isExecutableFile(atPath: propia) {
        return (propia, [])
    }

    for candidata in ["/opt/homebrew/bin/dsh", "/usr/local/bin/dsh"] where fm.isExecutableFile(atPath: candidata) {
        return (candidata, [])
    }

    let cache = fm.homeDirectoryForCurrentUser.appendingPathComponent(".npm/_npx")
    if let hashes = try? fm.contentsOfDirectory(atPath: cache.path) {
        for h in hashes.sorted() {
            let p = cache.appendingPathComponent("\(h)/node_modules/.bin/dsh").path
            if fm.isExecutableFile(atPath: p) { return (p, []) }
        }
    }

    for npx in ["/opt/homebrew/bin/npx", "/usr/local/bin/npx", "/usr/bin/npx"] where fm.isExecutableFile(atPath: npx) {
        return (npx, ["-y", "@deepseek-ai/dsh"])
    }

    return nil
}

func colaDelRegistro(_ lineas: Int = 6) -> String {
    guard let texto = try? String(contentsOf: registro, encoding: .utf8) else { return "" }
    return texto.split(separator: "\n").suffix(lineas).joined(separator: "\n")
}

// ── Aplicación ───────────────────────────────────────────────────────────────

final class Deepharn: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    var ventana: NSWindow!
    var web: WKWebView!
    var aviso: NSTextField!
    var detalle: NSTextField!
    var reintentar: NSButton!
    var harness: Process?
    var loSirvoYo = false
    /// Cierto mientras se canjea la ficha: la siguiente navegación que termine
    /// ya trae la galleta, y es entonces cuando se entra en nuestro frontend.
    var canjeando = false
    var puertoActivo = puertos[0]

    func applicationDidFinishLaunching(_ notification: Notification) {
        montarVentana()
        montarMenus()
        arrancar()
    }

    // ── Arranque ─────────────────────────────────────────────────────────────

    func arrancar() {
        mostrarAviso("Buscando el harness…", detalle: "")
        buscarVivo(puertos) { encontrado in
            if let puerto = encontrado {
                self.puertoActivo = puerto
                self.loSirvoYo = false
                self.mostrar()
            } else {
                self.lanzarHarness()
            }
        }
    }

    /// Recorre los puertos hasta encontrar uno que sirva nuestro frontend.
    func buscarVivo(_ pendientes: [Int], _ luego: @escaping (Int?) -> Void) {
        guard let puerto = pendientes.first else { return luego(nil) }
        responde(puerto) { vivo in
            if vivo { luego(puerto) } else { self.buscarVivo(Array(pendientes.dropFirst()), luego) }
        }
    }

    func lanzarHarness() {
        guard let (ejecutable, previos) = comoLanzar() else {
            fallo("No encuentro cómo arrancar el harness.",
                  detalle: "Instala Node y luego:  npm i -g @deepseek-ai/dsh")
            return
        }

        puertoActivo = puertos[0]
        mostrarAviso("Arrancando el harness…", detalle: "Puerto \(puertoActivo). La primera vez puede tardar.")

        let p = Process()
        p.executableURL = URL(fileURLWithPath: ejecutable)
        p.arguments = previos + ["--profile", perfil, "--port", String(puertoActivo), "--no-open"]
        // El directorio de trabajo se convierte en el espacio del agente, y con
        // la política «workspace-write» eso es lo que puede tocar sin pedir
        // permiso. Una app abierta desde el Finder arranca en «/», y la carpeta
        // personal entera es demasiado: se le da una suya.
        let casa = FileManager.default.homeDirectoryForCurrentUser
        let espacio = casa.appendingPathComponent("Deepharn")
        try? FileManager.default.createDirectory(at: espacio, withIntermediateDirectories: true)
        p.currentDirectoryURL = FileManager.default.fileExists(atPath: espacio.path) ? espacio : casa

        var entorno = ProcessInfo.processInfo.environment
        entorno["PATH"] = (entorno["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin"
        p.environment = entorno

        FileManager.default.createFile(atPath: registro.path, contents: nil)
        if let salida = try? FileHandle(forWritingTo: registro) {
            salida.seekToEndOfFile()
            p.standardOutput = salida
            p.standardError = salida
        }

        do {
            try p.run()
        } catch {
            fallo("No he podido arrancar el harness.", detalle: error.localizedDescription)
            return
        }

        harness = p
        loSirvoYo = true
        esperar(intentos: 150)
    }

    func esperar(intentos: Int) {
        guard intentos > 0 else {
            fallo("El harness no ha respondido a tiempo.", detalle: colaDelRegistro())
            return
        }
        if let p = harness, !p.isRunning, p.terminationStatus != 0 {
            fallo("El harness se ha cerrado al arrancar.", detalle: colaDelRegistro())
            return
        }
        responde(puertoActivo) { vivo in
            if vivo {
                self.mostrar()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.esperar(intentos: intentos - 1) }
            }
        }
    }

    /// Sano = responde nuestro propio endpoint, no solo el puerto.
    func responde(_ puerto: Int, _ luego: @escaping (Bool) -> Void) {
        var peticion = URLRequest(url: urlSalud(puerto))
        peticion.timeoutInterval = 2
        peticion.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: peticion) { _, respuesta, _ in
            let ok = (respuesta as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { luego(ok) }
        }.resume()
    }

    // ── Ventana ──────────────────────────────────────────────────────────────

    func montarVentana() {
        ventana = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        ventana.title = "Deepharn"
        ventana.minSize = NSSize(width: 900, height: 600)
        ventana.setFrameAutosaveName("VentanaPrincipal")
        ventana.center()

        // Puente con la página: así puede pedirnos que enseñemos un diálogo
        // nativo cuando el agente pide permiso.
        let configuracion = WKWebViewConfiguration()
        configuracion.userContentController.add(self, name: "deepharn")

        web = WKWebView(frame: .zero, configuration: configuracion)
        web.navigationDelegate = self
        // Sin esto, un <input type="file"> de la página no abre nada: WKWebView
        // no trae selector de archivos propio, lo pide a la app y, si la app no
        // contesta, se queda callado. Lo mismo con alert, confirm y prompt.
        web.uiDelegate = self
        web.autoresizingMask = [.width, .height]
        web.isHidden = true

        aviso = NSTextField(labelWithString: "")
        aviso.font = .systemFont(ofSize: 15, weight: .medium)
        aviso.alignment = .center
        aviso.translatesAutoresizingMaskIntoConstraints = false

        detalle = NSTextField(labelWithString: "")
        detalle.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        detalle.textColor = .secondaryLabelColor
        detalle.alignment = .center
        detalle.maximumNumberOfLines = 8
        detalle.translatesAutoresizingMaskIntoConstraints = false

        reintentar = NSButton(title: "Reintentar", target: self, action: #selector(volverAIntentar))
        reintentar.bezelStyle = .rounded
        reintentar.isHidden = true
        reintentar.translatesAutoresizingMaskIntoConstraints = false

        let raiz = NSView(frame: ventana.contentLayoutRect)
        raiz.autoresizingMask = [.width, .height]
        raiz.addSubview(web)
        raiz.addSubview(aviso)
        raiz.addSubview(detalle)
        raiz.addSubview(reintentar)
        web.frame = raiz.bounds

        NSLayoutConstraint.activate([
            aviso.centerXAnchor.constraint(equalTo: raiz.centerXAnchor),
            aviso.centerYAnchor.constraint(equalTo: raiz.centerYAnchor, constant: -30),
            detalle.centerXAnchor.constraint(equalTo: raiz.centerXAnchor),
            detalle.topAnchor.constraint(equalTo: aviso.bottomAnchor, constant: 12),
            detalle.widthAnchor.constraint(lessThanOrEqualToConstant: 620),
            reintentar.centerXAnchor.constraint(equalTo: raiz.centerXAnchor),
            reintentar.topAnchor.constraint(equalTo: detalle.bottomAnchor, constant: 18),
        ])

        ventana.contentView = raiz
        ventana.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func mostrar() {
        aviso.isHidden = true
        detalle.isHidden = true
        reintentar.isHidden = true
        web.isHidden = false

        // Si el harness pide credencial y tenemos la ficha, se canjea antes de
        // entrar: el canje deja la galleta en la vista web y ya no estorba más.
        entrar()
    }

    /// El harness escribe la ficha en su salida, y esa salida va a un archivo:
    /// puede tardar un instante en llegar al disco después de que el servidor
    /// ya responda. Por eso se espera a que aparezca en vez de entrar sin ella,
    /// que es lo que deja la pantalla en «authentication required».
    func entrar(intentos: Int = 40) {
        if let ficha = fichaDelRegistro(puertoActivo) {
            // El canje termina en «/», que ya es la interfaz oficial: no hace
            // falta navegar otra vez.
            canjeando = true
            web.load(URLRequest(url: urlCredencial(puertoActivo, ficha)))
            return
        }

        // Un harness ajeno, o una versión sin credencial: se entra tal cual.
        guard intentos > 0, loSirvoYo else {
            web.load(URLRequest(url: urlInicio(puertoActivo)))
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.entrar(intentos: intentos - 1) }
    }

    func mostrarAviso(_ texto: String, detalle textoDetalle: String) {
        aviso.stringValue = texto
        aviso.textColor = .labelColor
        aviso.isHidden = false
        detalle.stringValue = textoDetalle
        detalle.isHidden = textoDetalle.isEmpty
        reintentar.isHidden = true
        web.isHidden = true
    }

    func fallo(_ texto: String, detalle textoDetalle: String) {
        mostrarAviso(texto, detalle: textoDetalle)
        aviso.textColor = .systemOrange
        reintentar.isHidden = false
    }

    @objc func volverAIntentar() { arrancar() }


    func webView(_ vista: WKWebView, didFinish navegacion: WKNavigation!) {
        // El canje redirige a «/», así que al terminar ya estamos dentro.
        guard canjeando else { return }
        canjeando = false
    }


    // ── Diálogos de la página ────────────────────────────────────────────────
    //
    // WKWebView no implementa por su cuenta nada de lo que un navegador da por
    // hecho: ni selector de archivos, ni alert, ni confirm, ni prompt. Se los
    // pide a la app, y si la app calla, la página se queda esperando para
    // siempre. De ahí que el botón de adjuntar no hiciera nada.

    func webView(_ vista: WKWebView,
                 runOpenPanelWith parametros: WKOpenPanelParameters,
                 initiatedByFrame marco: WKFrameInfo,
                 completionHandler responder: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parametros.allowsMultipleSelection
        panel.canChooseDirectories = parametros.allowsDirectories
        panel.canChooseFiles = true
        panel.resolvesAliases = true

        let responderEnPrincipal: ([URL]?) -> Void = { urls in
            DispatchQueue.main.async { responder(urls) }
        }

        if let ventana = vista.window {
            panel.beginSheetModal(for: ventana) { respuesta in
                responderEnPrincipal(respuesta == .OK ? panel.urls : nil)
            }
        } else {
            responderEnPrincipal(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    func webView(_ vista: WKWebView,
                 runJavaScriptAlertPanelWithMessage mensaje: String,
                 initiatedByFrame marco: WKFrameInfo,
                 completionHandler terminar: @escaping () -> Void) {
        let alerta = NSAlert()
        alerta.messageText = "Deepharn"
        alerta.informativeText = mensaje
        alerta.addButton(withTitle: "Vale")
        alerta.runModal()
        terminar()
    }

    func webView(_ vista: WKWebView,
                 runJavaScriptConfirmPanelWithMessage mensaje: String,
                 initiatedByFrame marco: WKFrameInfo,
                 completionHandler responder: @escaping (Bool) -> Void) {
        let alerta = NSAlert()
        alerta.messageText = "Deepharn"
        alerta.informativeText = mensaje
        alerta.addButton(withTitle: "Aceptar")
        alerta.addButton(withTitle: "Cancelar")
        responder(alerta.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ vista: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt aviso: String,
                 defaultText porDefecto: String?,
                 initiatedByFrame marco: WKFrameInfo,
                 completionHandler responder: @escaping (String?) -> Void) {
        let alerta = NSAlert()
        alerta.messageText = "Deepharn"
        alerta.informativeText = aviso
        alerta.addButton(withTitle: "Aceptar")
        alerta.addButton(withTitle: "Cancelar")

        let campo = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        campo.stringValue = porDefecto ?? ""
        alerta.accessoryView = campo
        alerta.window.initialFirstResponder = campo

        responder(alerta.runModal() == .alertFirstButtonReturn ? campo.stringValue : nil)
    }

    /// Un enlace con target="_blank" no tiene dónde abrirse dentro de una sola
    /// ventana: si es del harness se carga aquí, y si es de fuera, al navegador.
    func webView(_ vista: WKWebView,
                 createWebViewWith configuracion: WKWebViewConfiguration,
                 for accion: WKNavigationAction,
                 windowFeatures caracteristicas: WKWindowFeatures) -> WKWebView? {
        guard let destino = accion.request.url else { return nil }
        if destino.host == "127.0.0.1" || destino.host == "localhost" {
            vista.load(URLRequest(url: destino))
        } else {
            NSWorkspace.shared.open(destino)
        }
        return nil
    }

    // ── Permisos ─────────────────────────────────────────────────────────────

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "deepharn",
              let datos = message.body as? [String: Any],
              let tipo = datos["tipo"] as? String else { return }

        // La pantalla de conexiones pide reiniciar: los servidores MCP se
        // conectan al arrancar, así que sin esto no aparecen.
        if tipo == "reiniciar" {
            reiniciarHarness()
            return
        }

        guard tipo == "permiso", let id = datos["id"] as? String else { return }

        let herramienta = datos["herramienta"] as? String ?? "una herramienta"
        let motivo = datos["motivo"] as? String ?? "Sin motivo declarado."
        preguntarPermiso(id: id, herramienta: herramienta, motivo: motivo)
    }

    /// Trae la app al frente y planta el diálogo. Si estás en otra cosa, el
    /// icono del Dock rebota hasta que atiendes.
    func preguntarPermiso(id: String, herramienta: String, motivo: String) {
        if !NSApp.isActive {
            NSApp.requestUserAttention(.criticalRequest)
            NSApp.activate(ignoringOtherApps: true)
        }

        let alerta = NSAlert()
        alerta.messageText = "El agente pide permiso para usar \(herramienta)"
        alerta.informativeText = motivo
        alerta.alertStyle = .warning
        alerta.addButton(withTitle: "Permitir una vez")
        alerta.addButton(withTitle: "Rechazar")

        let responder: (String) -> Void = { [weak self] decision in
            let escapado = id.replacingOccurrences(of: "'", with: "")
            self?.web.evaluateJavaScript("window.__responderPermiso && window.__responderPermiso('\(escapado)','\(decision)')")
        }

        if let ventana = ventana, ventana.isVisible {
            alerta.beginSheetModal(for: ventana) { respuesta in
                responder(respuesta == .alertFirstButtonReturn ? "allowed-once" : "rejected")
            }
        } else {
            responder(alerta.runModal() == .alertFirstButtonReturn ? "allowed-once" : "rejected")
        }
    }

    // ── Cierre ───────────────────────────────────────────────────────────────

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        guard loSirvoYo, let p = harness, p.isRunning else { return }
        p.terminate()
        let limite = Date().addingTimeInterval(5)
        while p.isRunning && Date() < limite {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    // ── Enlaces externos ─────────────────────────────────────────────────────

    func webView(_ webView: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.allow); return }
        let local = (url.host == "127.0.0.1" || url.host == "localhost")
        if !local, action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // Si lo que ha fallado es el canje de la credencial, se entra igual:
        // la página avisará de que no la tiene, que es mejor que un error seco.
        if canjeando {
            canjeando = false
            webView.load(URLRequest(url: urlInicio(puertoActivo)))
            return
        }
        fallo("No he podido cargar Deepharn.", detalle: error.localizedDescription)
    }

    // ── Menús ────────────────────────────────────────────────────────────────

    func montarMenus() {
        let barra = NSMenu()

        let mApp = NSMenuItem()
        let app = NSMenu()
        app.addItem(withTitle: "Acerca de Deepharn", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Ocultar Deepharn", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: "Salir de Deepharn", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        mApp.submenu = app
        barra.addItem(mApp)

        let mEditar = NSMenuItem()
        let editar = NSMenu(title: "Edición")
        editar.addItem(withTitle: "Deshacer", action: Selector(("undo:")), keyEquivalent: "z")
        editar.addItem(withTitle: "Rehacer", action: Selector(("redo:")), keyEquivalent: "Z")
        editar.addItem(.separator())
        editar.addItem(withTitle: "Cortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editar.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editar.addItem(withTitle: "Pegar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editar.addItem(withTitle: "Seleccionar todo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        mEditar.submenu = editar
        barra.addItem(mEditar)

        let mVista = NSMenuItem()
        let vista = NSMenu(title: "Vista")
        vista.addItem(withTitle: "Recargar", action: #selector(recargar), keyEquivalent: "r")
        vista.addItem(withTitle: "Pantalla completa", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        vista.addItem(.separator())
        vista.addItem(withTitle: "Interfaz de DeepSeek", action: #selector(irAOficial), keyEquivalent: "0")
        vista.addItem(withTitle: "Nuestro frontend (en pruebas)", action: #selector(irADeepharn), keyEquivalent: ",")
        vista.addItem(.separator())
        vista.addItem(withTitle: "Reiniciar el harness", action: #selector(reiniciarHarness), keyEquivalent: "R")
        vista.addItem(withTitle: "Ver el registro", action: #selector(verRegistro), keyEquivalent: "l")
        mVista.submenu = vista
        barra.addItem(mVista)

        NSApp.mainMenu = barra
    }

    @objc func recargar() { web.reload() }
    @objc func irADeepharn() { web.load(URLRequest(url: urlApp(puertoActivo))) }
    @objc func irAOficial() { web.load(URLRequest(url: urlOficial(puertoActivo))) }
    @objc func verRegistro() { NSWorkspace.shared.open(registro) }

    /// Para el harness que arrancó esta app y vuelve a levantarlo. Hace falta
    /// tras instalar un plugin o añadir una skill: el árbol se compone al boot.
    @objc func reiniciarHarness() {
        if loSirvoYo, let p = harness, p.isRunning {
            p.terminate()
            let limite = Date().addingTimeInterval(5)
            while p.isRunning && Date() < limite {
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            }
        }
        harness = nil
        loSirvoYo = false
        arrancar()
    }
}

// ── Arranque ─────────────────────────────────────────────────────────────────

let app = NSApplication.shared
let delegado = Deepharn()
app.delegate = delegado
app.setActivationPolicy(.regular)
app.run()
