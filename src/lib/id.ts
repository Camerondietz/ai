/** Random identifier for stored records. */
export function uid(): string {
  return crypto.randomUUID();
}

/** Short, human-friendly suffix (e.g. for default names). */
export function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}
