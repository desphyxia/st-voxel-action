/**
 * Input, as a table rather than as a switch statement.
 *
 * Bindings are data from the first commit, because retrofitting remapping is
 * the expensive version of this (issue #11) and doing it now costs a map and a
 * lookup. Nothing here touches the DOM: a page calls `press`/`release` with
 * whatever its event gives it, a pad poller calls `stick`, and the sim reads
 * the same three numbers either way.
 *
 * Codes are `KeyboardEvent.code` — physical keys, so WASD stays under the same
 * fingers on an AZERTY keyboard — plus `Pad<n>` for gamepad buttons and
 * `Mouse<n>` for mouse buttons.
 */

/** Every action the prototype has. Adding a verb adds a row here. */
export const ACTIONS = [
  'moveUp', 'moveDown', 'moveLeft', 'moveRight',
  'jump', 'attack', 'dodge', 'rotateLeft', 'rotateRight', 'respawn',
];

export const DEFAULT_BINDINGS = {
  moveUp: ['KeyW', 'ArrowUp'],
  moveDown: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  jump: ['Space', 'Pad0'],
  attack: ['Mouse0', 'KeyF', 'Pad2'],
  dodge: ['ShiftLeft', 'Pad1'],
  rotateLeft: ['KeyQ', 'Pad4'],
  rotateRight: ['KeyE', 'Pad5'],
  respawn: ['KeyR', 'Pad9'],
};

/** A fresh copy, so a caller's edits never reach the defaults. */
export function defaultBindings() {
  const out = {};
  for (const a of ACTIONS) out[a] = (DEFAULT_BINDINGS[a] || []).slice();
  return out;
}

export function makeInput(bindings) {
  let map = bindings ? normalise(bindings) : defaultBindings();
  let byCode = index(map);
  const held = new Set();          /* codes physically down */
  const edges = new Set();         /* actions pressed since last read */
  const st = { lx: 0, ly: 0, ax: 0, ay: 0, px: 0, py: 0, pointer: false };

  function normalise(b) {
    const out = {};
    for (const a of ACTIONS) out[a] = (b[a] || []).slice();
    return out;
  }
  function index(m) {
    const ix = new Map();
    for (const a of ACTIONS) for (const code of m[a]) {
      if (!ix.has(code)) ix.set(code, []);
      ix.get(code).push(a);
    }
    return ix;
  }

  return {
    press(code) {
      if (held.has(code)) return;              /* ignore auto-repeat */
      held.add(code);
      for (const a of byCode.get(code) || []) edges.add(a);
    },
    release(code) { held.delete(code); },
    /** Window blur, or a pad unplugged: nothing is down any more. */
    releaseAll() { held.clear(); st.lx = st.ly = st.ax = st.ay = 0; },

    /** Is the action held right now? */
    down(action) {
      for (const code of map[action] || []) if (held.has(code)) return true;
      return false;
    },
    /** Was it pressed since the last call? Consumed, so a snap fires once. */
    took(action) {
      if (!edges.has(action)) return false;
      edges.delete(action);
      return true;
    },

    /** Left stick, screen space, y up. Overridden by keys while they are held. */
    stick(x, y) { st.lx = x; st.ly = y; },
    /** Right stick, same space. Drives aim. */
    aimStick(x, y) { st.ax = x; st.ay = y; },
    /** Pointer position in viewport pixels. */
    pointer(x, y) { st.px = x; st.py = y; st.pointer = true; },
    get aim() { return { x: st.ax, y: st.ay }; },
    get cursor() { return { x: st.px, y: st.py, active: st.pointer }; },

    /**
     * The movement heading, in screen space. Keys win over the stick when both
     * are live, because a resting stick that has drifted should never fight a
     * held key.
     */
    axes() {
      let ix = 0, iy = 0;
      if (this.down('moveRight')) ix += 1;
      if (this.down('moveLeft')) ix -= 1;
      if (this.down('moveUp')) iy += 1;
      if (this.down('moveDown')) iy -= 1;
      if (ix === 0 && iy === 0) { ix = st.lx; iy = st.ly; }
      return { ix, iy };
    },

    /** Rebind one action. Returns false for an action that does not exist. */
    bind(action, codes) {
      if (!ACTIONS.includes(action)) return false;
      map[action] = codes.slice();
      byCode = index(map);
      return true;
    },
    /** The current table, copied — safe to serialise and hand back later. */
    bindings() { return normalise(map); },
    reset() { map = defaultBindings(); byCode = index(map); },

    /** Which actions a code currently drives. For a remap UI's clash warning. */
    usedBy(code) { return (byCode.get(code) || []).slice(); },
  };
}
