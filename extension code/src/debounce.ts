export function debounceLeading<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
): T & { cancel(): void } {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let ready = true;

  const debounced = (...args: Parameters<T>) => {
    if (ready) {
      ready = false;
      fn(...args);
      timeout = setTimeout(() => { ready = true; }, ms);
      return;
    }
    if (timeout !== undefined) { clearTimeout(timeout); }
    timeout = setTimeout(() => { ready = true; fn(...args); }, ms);
  };

  debounced.cancel = () => {
    if (timeout !== undefined) { clearTimeout(timeout); timeout = undefined; }
    ready = true;
  };

  return debounced as T & { cancel(): void };
}
