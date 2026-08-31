import { createServerFn } from "@tanstack/react-start";

export type AllowedGameImportRow = {
  game_id: string;
  name: string | null;
  enabled: boolean;
  script_url: string | null;
  universe_id?: string | null;
  is_paid?: boolean;
  added_at?: string;
};

type AllowedGamePatch = {
  game_id?: string;
  name?: string | null;
  enabled?: boolean;
  script_url?: string | null;
  universe_id?: string | null;
  is_paid?: boolean;
  no_timer?: boolean;
  session_seconds?: number | null;
  cooldown_seconds?: number | null;
};

function validateRows(raw: unknown): AllowedGameImportRow[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) {
    throw new Error("Import must contain between 1 and 500 games");
  }
  return raw.map((value) => {
    const row = value as Partial<AllowedGameImportRow>;
    const gameId = String(row.game_id ?? "").trim();
    if (!/^\d+$/.test(gameId)) throw new Error("Every game ID must be numeric");
    return {
      game_id: gameId,
      name: row.name == null ? null : String(row.name).slice(0, 500),
      enabled: row.enabled !== false,
      script_url: row.script_url == null ? null : String(row.script_url).slice(0, 2048),
      ...(row.universe_id ? { universe_id: String(row.universe_id).slice(0, 64) } : {}),
      ...(typeof row.is_paid === "boolean" ? { is_paid: row.is_paid } : {}),
      ...(row.added_at ? { added_at: String(row.added_at).slice(0, 40) } : {}),
    };
  });
}

export const listAllowedGames = createServerFn({ method: "GET" })
  .handler(async () => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("allowed_games")
      .select("game_id, name, enabled, added_at, is_paid, no_timer, script_url, session_seconds, cooldown_seconds, universe_id")
      .order("added_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`Game list failed: ${error.message}`);
    return (data ?? []) as Array<AllowedGameImportRow & {
      added_at: string;
      no_timer?: boolean;
      session_seconds?: number | null;
      cooldown_seconds?: number | null;
    }>;
  });

export const upsertAllowedGames = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => ({ rows: validateRows((data as { rows?: unknown })?.rows) }))
  .handler(async ({ data }) => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("allowed_games")
      .upsert(data.rows, { onConflict: "game_id" });
    if (error) throw new Error(`Game import failed: ${error.message}`);
    return { count: data.rows.length };
  });

export const updateAllowedGame = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => data)
  .handler(async ({ data }) => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const payload = data as { gameIds?: unknown; patch?: unknown };
    const ids = Array.isArray(payload.gameIds) ? payload.gameIds.map(String).filter((id) => /^\d+$/.test(id)) : [];
    if (!ids.length || ids.length > 500 || !payload.patch || typeof payload.patch !== "object") throw new Error("Invalid game update");
    const patch = payload.patch as AllowedGamePatch;
    const { error } = await supabaseAdmin.from("allowed_games").update(patch).in("game_id", ids);
    if (error) throw new Error(`Game update failed: ${error.message}`);
    return { count: ids.length };
  });

export const deleteAllowedGames = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => data)
  .handler(async ({ data }) => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const ids = Array.isArray((data as { gameIds?: unknown })?.gameIds) ? (data as { gameIds: string[] }).gameIds.filter((id) => /^\d+$/.test(id)) : [];
    if (!ids.length || ids.length > 500) throw new Error("Invalid game delete");
    const { error } = await supabaseAdmin.from("allowed_games").delete().in("game_id", ids);
    if (error) throw new Error(`Game delete failed: ${error.message}`);
    return { count: ids.length };
  });

// ---- Import-from-API: pull a game list from a remote endpoint (replaces hardcoded lists) ----
export const DEFAULT_GAME_LIST_API = "https://combo0-chroncile.vercel.app/api/roblox";

type RemoteGameRow = { game_id: string; script_url: string | null; extra_urls: string[] };

function collectUrls(value: unknown): string[] {
  if (typeof value === "string") {
    const v = value.trim();
    return v ? [v] : [];
  }
  if (Array.isArray(value)) return value.flatMap(collectUrls);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const raw = o.url ?? o.script_url ?? o.scriptUrl ?? o.raw_url ?? o.rawUrl ?? o.link ?? o.src;
    return collectUrls(raw);
  }
  return [];
}

function extractRemoteRows(parsed: unknown, out: Map<string, RemoteGameRow>) {
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        const id = String(o.game_id ?? o.gameId ?? o.id ?? o.placeId ?? o.place_id ?? "").trim();
        if (/^\d+$/.test(id)) {
          const urls = collectUrls(o);
          out.set(id, { game_id: id, script_url: urls[0] ?? null, extra_urls: urls.slice(1) });
          continue;
        }
      }
      extractRemoteRows(entry, out);
    }
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = key.trim();
    if (/^\d+$/.test(id)) {
      const urls = collectUrls(value);
      out.set(id, { game_id: id, script_url: urls[0] ?? null, extra_urls: urls.slice(1) });
    } else if (value && typeof value === "object") {
      extractRemoteRows(value, out);
    }
  }
}

export const fetchRemoteGameList = createServerFn({ method: "POST" })
  .inputValidator((input: { url?: string } | undefined) => {
    const raw = (input?.url ?? DEFAULT_GAME_LIST_API).toString().trim() || DEFAULT_GAME_LIST_API;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("Invalid API URL");
    }
    if (parsed.protocol !== "https:") throw new Error("API URL must use https");
    return { url: parsed.toString() };
  })
  .handler(async ({ data }) => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();

    const res = await fetch(data.url, {
      headers: { Accept: "application/json", "User-Agent": "HWID-Admin/1.0" },
    });
    if (!res.ok) throw new Error(`API responded ${res.status}`);

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("API did not return valid JSON");
    }

    const map = new Map<string, RemoteGameRow>();
    extractRemoteRows(json, map);
    const rows = Array.from(map.values());
    if (rows.length === 0) throw new Error("No game IDs found in API response");
    return { url: data.url, rows };
  });
