// Small hooks shared by the dashboard.
import { useCallback, useInsertionEffect, useRef, useState } from 'react';

// A stable function that always runs the latest `fn` (what React 19's useEffectEvent does).
// For document listeners that must see current props without re-subscribing on every render.
export function useEvent(fn) {
  const ref = useRef(fn);
  useInsertionEffect(() => { ref.current = fn; });
  return useCallback((...args) => ref.current(...args), []);
}

// A button that needs a second press within ARM_MS (Finish, Start over an unsaved ride, Clear...).
// `press(action)` arms on the first press and runs `action` on the second. A second press that
// lands within ARM_GUARD_MS of the first is a double tap, not a decision, so it is ignored.
// Disarms by itself after ARM_MS, and when `resetKey` changes (e.g. the ride state).
export const ARM_MS = 4000, ARM_GUARD_MS = 500;
export function useArmed(resetKey) {
  const [arm, setArm] = useState(null);           // { at, key } while armed
  if (arm && arm.key !== resetKey) setArm(null);  // reset on key change, during render
  const armed = arm !== null && arm.key === resetKey;
  const press = action => {
    if (!armed) {
      const a = { at: Date.now(), key: resetKey };
      setArm(a);
      setTimeout(() => setArm(cur => (cur === a ? null : cur)), ARM_MS);
      return;
    }
    if (Date.now() - arm.at < ARM_GUARD_MS) return;
    setArm(null); action();
  };
  return [armed, press];
}

// Measured content width of an element, kept up to date by a ResizeObserver attached through
// a ref callback (no effect). Returns [ref, width]; `ref` also fills `nodeRef` when given.
export function useWidth(nodeRef) {
  const [w, setW] = useState(0);
  const ro = useRef(null);
  const ref = useCallback(node => {
    if (ro.current) { ro.current.disconnect(); ro.current = null; }
    if (nodeRef) nodeRef.current = node;
    if (!node) return;
    ro.current = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.current.observe(node);
  }, [nodeRef]);
  return [ref, w];
}
