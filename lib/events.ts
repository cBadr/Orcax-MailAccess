// In-process pub/sub for SSE. For production (multi-instance) swap with
// Postgres LISTEN/NOTIFY or Upstash Redis pub/sub — same interface.

type Listener = (event: string, data: unknown) => void;

const channels = new Map<string, Set<Listener>>();

export function subscribe(channel: string, listener: Listener): () => void {
  let set = channels.get(channel);
  if (!set) {
    set = new Set();
    channels.set(channel, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) channels.delete(channel);
  };
}

export function publish(channel: string, event: string, data: unknown): void {
  const set = channels.get(channel);
  if (!set) return;
  for (const l of set) {
    try {
      l(event, data);
    } catch {
      // best-effort
    }
  }
  // Broadcast channel for dashboards watching everything.
  if (channel !== "*") {
    const all = channels.get("*");
    if (all) for (const l of all) try { l(event, data); } catch {}
  }
}
