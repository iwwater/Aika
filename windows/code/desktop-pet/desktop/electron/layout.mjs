const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export function fitDisplay(width, open, screen, anchor, mode = 'full') {
  const sw = Math.max(1, screen.width), sh = Math.max(1, screen.height), aspect = 340 / 360;
  const mw = Math.max(1, Math.min(width, sw - 20, (sh - 36) / aspect)), mh = mw * aspect;
  const pet = { x: clamp(anchor.x - (mw + 20) / 2, screen.x, screen.x + sw - mw - 20),
    y: clamp(anchor.y, screen.y, screen.y + sh - mh - 36), width: mw + 20, height: mh + 36 };
  const dw = Math.min(480, sw - 20), dh = Math.min(540, sh), gap = 8;
  const right = screen.x + sw - pet.x - pet.width - gap, left = pet.x - screen.x - gap;
  const below = screen.y + sh - pet.y - pet.height - gap, above = pet.y - screen.y - gap;
  const drawer = { x: clamp(pet.x + pet.width / 2 - dw / 2, screen.x, screen.x + sw - dw), y: screen.y, width: dw, height: dh };
  let placement = 'hidden';
  if (open) {
    if (below >= dh) { drawer.y = pet.y + pet.height + gap; placement = 'below'; }
    else if (Math.max(left, right) >= dw) { placement = right >= left ? 'right' : 'left'; drawer.x = placement === 'right' ? pet.x + pet.width + gap : pet.x - dw - gap; drawer.y = clamp(pet.y, screen.y, screen.y + sh - dh); }
    else if (above >= dh) { drawer.y = pet.y - dh - gap; placement = 'above'; }
    else { placement = 'overlay'; drawer.y = clamp(pet.y, screen.y, screen.y + sh - dh); }
  }
  const x = Math.floor(open ? Math.min(pet.x, drawer.x) : pet.x), y = Math.floor(open ? Math.min(pet.y, drawer.y) : pet.y);
  const bounds = { x, y, width: Math.ceil((open ? Math.max(pet.x + pet.width, drawer.x + dw) : pet.x + pet.width) - x),
    height: Math.ceil((open ? Math.max(pet.y + pet.height, drawer.y + dh) : pet.y + pet.height) - y) };
  return { bounds, anchor: { x: pet.x + pet.width / 2, y: pet.y }, config: { mode, preferredWidth: width,
    modelWidth: mw, modelHeight: mh, drawerHeight: open ? dh : 0, petLeft: pet.x - x, petTop: pet.y - y, petWidth: pet.width,
    drawerLeft: drawer.x - x, drawerTop: drawer.y - y, drawerWidth: dw, placement } };
}
