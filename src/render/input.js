// Keyboard input for the player kart, with a scriptable override used by tests.

export function createInput(target = window) {
  const keys = new Set();
  let override = null; // {throttle, steer} or function(t) -> {throttle, steer}
  const down = (e) => {
    keys.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  const up = (e) => keys.delete(e.code);
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', () => keys.clear());
  return {
    keys,
    read(time) {
      if (override) return typeof override === 'function' ? override(time) : override;
      let throttle = 0, steer = 0;
      if (keys.has('ArrowUp') || keys.has('KeyW')) throttle += 1;
      if (keys.has('ArrowDown') || keys.has('KeyS')) throttle -= 1;
      if (keys.has('ArrowLeft') || keys.has('KeyA')) steer += 1;
      if (keys.has('ArrowRight') || keys.has('KeyD')) steer -= 1;
      return { throttle, steer };
    },
    setOverride(v) {
      override = v;
    },
    pressed(code) {
      return keys.has(code);
    },
    dispose() {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
    },
  };
}
