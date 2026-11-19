import AppKit
let args = CommandLine.arguments
let text = args[1]
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 25, weight: .medium), .foregroundColor: NSColor.white]
let size = (text as NSString).size(withAttributes: attrs)
let image = NSImage(size: NSSize(width: ceil(size.width)+20, height: ceil(size.height)+12))
image.lockFocus()
NSColor.black.withAlphaComponent(0.8).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: image.size)).fill()
(text as NSString).draw(at: NSPoint(x: 10, y: 6), withAttributes: attrs)
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
