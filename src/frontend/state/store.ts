import { useEffect, useRef, useState } from "preact/hooks";

/** Small observable store (immutable snapshots). */
export class Store<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();
  constructor(initial: T) {
    this.value = initial;
  }
  get(): T {
    return this.value;
  }
  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  /** Shallow patch for object stores. */
  patch(patch: Partial<T>): void {
    this.set({ ...this.value, ...patch });
  }
  update(fn: (value: T) => T): void {
    this.set(fn(this.value));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Subscribes a component to a selected part of a store (re-renders when the selection changes by `Object.is`).
 * The selection is taken on every render, so a selector over props or other state follows them right away.
 */
export function useSelector<T, S>(store: Store<T>, selector: (value: T) => S): S {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const selected = selector(store.get());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [, rerender] = useState(0);
  useEffect(() => {
    const check = () => {
      if (!Object.is(selectorRef.current(store.get()), selectedRef.current)) rerender((n) => n + 1);
    };
    check();
    return store.subscribe(check);
  }, [store]);
  return selected;
}
