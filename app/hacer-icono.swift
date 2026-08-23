// Genera el icono de Deepharn sin depender de nada externo: lo dibuja con
// CoreGraphics y escribe el .iconset que iconutil convierte en .icns.
//
// Uso:  swift hacer-icono.swift <carpeta-destino.iconset>
//
// El dibujo: cuadrado redondeado en verde petróleo sobre fondo oscuro, con un
// arco abierto —el arnés— y un punto dentro. La idea es «algo sujeto pero con
// holgura», que es lo que hace un harness.

import AppKit

let destino = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Deepharn.iconset"
try? FileManager.default.createDirectory(atPath: destino, withIntermediateDirectories: true)

func dibujar(lado: Int) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: lado, pixelsHigh: lado,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    let n = CGFloat(lado)

    // Margen del icono de macOS: el arte no llega al borde.
    let margen = n * 0.09
    let caja = CGRect(x: margen, y: margen, width: n - margen * 2, height: n - margen * 2)
    let radio = caja.width * 0.235

    // Fondo: degradado oscuro con un punto de verde.
    let fondo = CGPath(roundedRect: caja, cornerWidth: radio, cornerHeight: radio, transform: nil)
    ctx.saveGState()
    ctx.addPath(fondo)
    ctx.clip()
    let espacio = CGColorSpaceCreateDeviceRGB()
    let degradado = CGGradient(colorsSpace: espacio, colors: [
        CGColor(red: 0.086, green: 0.396, blue: 0.416, alpha: 1),   // #166a6a
        CGColor(red: 0.043, green: 0.161, blue: 0.176, alpha: 1),   // #0b292d
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(degradado, start: CGPoint(x: caja.minX, y: caja.maxY),
                           end: CGPoint(x: caja.maxX, y: caja.minY), options: [])
    ctx.restoreGState()

    // El arco: casi un círculo, abierto por la derecha.
    let centro = CGPoint(x: caja.midX, y: caja.midY)
    let radioArco = caja.width * 0.27
    let grosor = caja.width * 0.105
    ctx.setLineWidth(grosor)
    ctx.setLineCap(.round)
    ctx.setStrokeColor(CGColor(red: 0.878, green: 0.937, blue: 0.918, alpha: 1)) // #e0efea
    ctx.addArc(center: centro, radius: radioArco,
               startAngle: -.pi * 0.30, endAngle: .pi * 1.28, clockwise: false)
    ctx.strokePath()

    // El punto suelto dentro del arco, desplazado hacia la abertura.
    let puntoRadio = caja.width * 0.082
    ctx.setFillColor(CGColor(red: 0.482, green: 0.808, blue: 0.776, alpha: 1)) // #7bcec6
    ctx.fillEllipse(in: CGRect(
        x: centro.x + radioArco * 0.42 - puntoRadio,
        y: centro.y - radioArco * 0.34 - puntoRadio,
        width: puntoRadio * 2, height: puntoRadio * 2
    ))

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

// Los tamaños que pide un .iconset de macOS.
let tamanos: [(Int, String)] = [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]

for (lado, nombre) in tamanos {
    let rep = dibujar(lado: lado)
    guard let datos = rep.representation(using: .png, properties: [:]) else { continue }
    try? datos.write(to: URL(fileURLWithPath: "\(destino)/\(nombre)"))
}

print("iconset escrito en \(destino)")
