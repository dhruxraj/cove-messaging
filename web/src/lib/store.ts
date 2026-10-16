import { useRef, useSyncExternalStore } from 'react';

/** A tiny external store: immutable state, subscribe, and a selector hook with shallow memo. */
export function createStore<S>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  const get = () => state;
  const set = (update: Partial<S> | ((s: S) => Partial<S>)) => {
    const patch = typeof update === 'function' ? (update as (s: S) => Partial<S>)(state) : update;
    if (!patch || Object.keys(patch).length === 0) return;
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  function useStore<T>(selector: (s: S) => T, equal: (a: T, b: T) => boolean = Object.is): T {
    const last = useRef<{ value: T } | null>(null);
    const getSnapshot = () => {
      const next = selector(state);
      if (last.current && equal(last.current.value, next)) return last.current.value;
      last.current = { value: next };
      return next;
    };
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }
  return { get, set, subscribe, useStore };
}

export function shallowArray<T>(a: T[], b: T[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
