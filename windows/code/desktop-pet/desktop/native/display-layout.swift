import Foundation
import CoreGraphics

// Private shell geometry in logical points. Screen fitting never writes preferences.
struct PetDisplayLayout {
    static let aspect = 340.0 / 360.0
    let frame: CGRect
    let modelWidth: Double
    let modelHeight: Double
    let drawerHeight: Double
    let modelFrame: CGRect
    let petFrame: CGRect
    let drawerFrame: CGRect
    let viewport: CGRect
    let placement: String
    // Anchor is the MODEL's screen-space top centre, never the enclosing window.
    static func fit(width: Double, open: Bool, screen: CGRect, anchor: CGPoint) -> PetDisplayLayout {
        let available = max(1, screen.height - 36)
        let modelWidth = max(1, min(width, max(1, screen.width - 20), available / aspect))
        let modelHeight = modelWidth * aspect
        let petWidth = min(screen.width, modelWidth + 20), petHeight = min(screen.height, modelHeight + 36)
        let x = min(max(anchor.x - petWidth / 2, screen.minX), screen.maxX - petWidth)
        let y = min(max(anchor.y - petHeight, screen.minY), screen.maxY - petHeight)
        let pet = CGRect(x:x,y:y,width:petWidth,height:petHeight)
        let model = CGRect(x:pet.midX-modelWidth/2,y:pet.maxY-modelHeight,width:modelWidth,height:modelHeight)
        let gap = 8.0, drawerWidth = min(480, max(1, screen.width - 20))
        let drawerX = min(max(pet.midX-drawerWidth/2,screen.minX+min(10,screen.width/2)),screen.maxX-drawerWidth-min(10,screen.width/2))
        let below = max(0,pet.minY-screen.minY-gap), above = max(0,screen.maxY-pet.maxY-gap)
        let right = max(0,screen.maxX-pet.maxX-gap), left = max(0,pet.minX-screen.minX-gap)
        var drawer = CGRect.zero, placement = "hidden"
        func vertical(_ bottom:Bool,_ height:Double) -> CGRect {
            CGRect(x:drawerX,y:bottom ? pet.minY-gap-height : pet.maxY+gap,width:drawerWidth,height:height)
        }
        func side(_ useRight:Bool) -> CGRect {
            let w=min(drawerWidth,useRight ? right:left), h=min(540,screen.height)
            return CGRect(x:useRight ? pet.maxX+gap : pet.minX-gap-w,y:min(max(pet.maxY-h,screen.minY),screen.maxY-h),width:w,height:h)
        }
        if open {
            // Try full reading space before accepting a smaller neighbouring slot.
            if below >= 540 { drawer=vertical(true,540);placement="below" }
            else if max(left,right) >= drawerWidth && screen.height >= 540 {
                let useRight=right>=left;drawer=side(useRight);placement=useRight ? "right":"left"
            } else if above >= 540 { drawer=vertical(false,540);placement="above" }
            else if below >= 340 { drawer=vertical(true,min(540,below));placement="below" }
            else if max(left,right) >= min(320,drawerWidth) {
                let useRight=right>=left;drawer=side(useRight)
                placement=useRight ? "right":"left"
            } else if above >= 340 { drawer=vertical(false,min(540,above));placement="above" }
            else {
                // On a screen almost filled by the model, a scrollable overlay is
                // the only available space. It never changes the model's geometry.
                drawer=CGRect(x:drawerX,y:screen.minY,width:drawerWidth,height:min(540,screen.height))
                placement="overlay"
            }
        }
        return PetDisplayLayout(frame:open ? pet.union(drawer):pet,modelWidth:modelWidth,modelHeight:modelHeight,drawerHeight:drawer.height,modelFrame:model,petFrame:pet,drawerFrame:drawer,viewport:screen,placement:placement)
    }

    // CSS origin is the screen's top-left; AppKit's is the bottom-left.
    var webOrigin: CGPoint { CGPoint(x:viewport.minX-frame.minX,y:viewport.minY-frame.minY) }
    var configuration: [String:Any] {
        ["modelWidth":modelWidth,"modelHeight":modelHeight,"drawerHeight":drawerHeight,
         "petLeft":petFrame.minX-viewport.minX,"petTop":viewport.maxY-petFrame.maxY,"petWidth":petFrame.width,
         "drawerLeft":drawerFrame.minX-viewport.minX,"drawerTop":viewport.maxY-drawerFrame.maxY,"drawerWidth":drawerFrame.width,"placement":placement]
    }
}

final class PetDisplayPreferences {
    static let minimumWidth = 220.0, maximumWidth = 720.0
    private let defaults: UserDefaults
    private(set) var mode: String
    private(set) var width: Double
    private var beforeResize: Double?
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        mode = defaults.string(forKey: "petDisplay.mode") == "half" ? "half" : "full"
        let value = defaults.object(forKey: "petDisplay.width") as? Double ?? 360
        width = value.isFinite ? min(Self.maximumWidth, max(Self.minimumWidth, value)) : 360
    }
    func setMode(_ value: String) {
        guard ["full", "half"].contains(value) else { return }
        resize("cancel", width: nil)
        mode = value; defaults.set(mode, forKey: "petDisplay.mode")
    }
    func resize(_ phase: String, width value: Double?) {
        if phase == "begin" { if beforeResize == nil { beforeResize = width }; return }
        guard let original = beforeResize else { return }
        if phase == "cancel" { width = original; beforeResize = nil; return }
        guard ["update", "commit"].contains(phase), let value, value.isFinite else { return }
        width = min(Self.maximumWidth, max(Self.minimumWidth, value))
        if phase == "commit" { defaults.set(width, forKey: "petDisplay.width"); beforeResize = nil }
    }
}
