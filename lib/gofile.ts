export interface GofileUploadResult {
  ok: boolean;
  downloadPage?: string;
  directLink?: string;
  fileId?: string;
  folderId?: string;
  error?: string;
  raw?: unknown;
}

async function getServer(token?: string): Promise<string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const r = await fetch("https://api.gofile.io/servers", { headers });
  if (!r.ok) throw new Error(`getServer failed: ${r.status}`);
  const j: any = await r.json();
  const servers = j?.data?.servers;
  if (!Array.isArray(servers) || !servers.length) throw new Error("no gofile servers available");
  const pick = servers[Math.floor(Math.random() * servers.length)];
  return pick.name || pick.server || servers[0].name;
}

export async function uploadToGofile(
  filename: string,
  content: string | Uint8Array,
  opts: { token?: string; folderId?: string } = {},
): Promise<GofileUploadResult> {
  try {
    const server = await getServer(opts.token);
    const form = new FormData();
    const blob =
      typeof content === "string"
        ? new Blob([content], { type: "text/plain" })
        : new Blob([content]);
    form.append("file", blob, filename);
    if (opts.folderId) form.append("folderId", opts.folderId);

    const headers: Record<string, string> = {};
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;

    const r = await fetch(`https://${server}.gofile.io/contents/uploadfile`, {
      method: "POST",
      headers,
      body: form,
    });
    const j: any = await r.json();
    if (j?.status !== "ok") {
      return { ok: false, error: j?.status || `http ${r.status}`, raw: j };
    }
    const d = j.data || {};
    return {
      ok: true,
      downloadPage: d.downloadPage,
      directLink: d.directLink,
      fileId: d.fileId || d.id,
      folderId: d.parentFolder || d.folderId,
      raw: j,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
