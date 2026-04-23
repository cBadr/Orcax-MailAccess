// Worker-thread entry. Kept as plain JS so it can be spawned via `new Worker(__filename)`
// without relying on Next's build output. Loads the compiled verify-core via require.
//
// Vercel runs each lambda on a single vCPU, so worker_threads give little benefit there.
// This is most useful for self-hosted deployments (VM / container / Docker).

const { parentPort, workerData } = require("worker_threads");

async function run() {
  // Resolve the server-side bundle Next produced for verify-core. We try a few paths
  // so this works in `next dev`, `next start`, and standalone builds.
  let verifyOne;
  const candidates = [
    // Next dev / start — server reference (TS source via ts-node is not available at runtime,
    // so prod builds should transpile lib/verify-core to .js at build time; the require call
    // below looks for the compiled JS next to this file via a sibling `dist/` folder or
    // the Next server bundle path provided through workerData.requirePath).
    workerData && workerData.requirePath,
    require.resolve("../verify-core.js"),
    require.resolve("../../.next/server/lib/verify-core.js"),
  ].filter(Boolean);

  let lastErr;
  for (const p of candidates) {
    try {
      const mod = require(p);
      verifyOne = mod.verifyOne || (mod.default && mod.default.verifyOne);
      if (verifyOne) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!verifyOne) {
    parentPort.postMessage({ ok: false, error: "verify-core not resolvable: " + String(lastErr) });
    return;
  }

  parentPort.on("message", async (msg) => {
    if (!msg || msg.type !== "task") return;
    try {
      const result = await verifyOne(msg.input);
      parentPort.postMessage({ type: "result", id: msg.id, ok: true, result });
    } catch (e) {
      parentPort.postMessage({ type: "result", id: msg.id, ok: false, error: String(e && e.message || e) });
    }
  });

  parentPort.postMessage({ type: "ready" });
}

run().catch((e) => {
  try { parentPort.postMessage({ type: "fatal", error: String(e && e.message || e) }); } catch {}
});
