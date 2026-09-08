import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  SCRIPT_CONTENT,
  PAID_SCRIPT_SENTINEL,
  PAID_SCRIPT_LOADER,
  DISABLED_SCRIPT_SENTINEL,
  DISABLED_SCRIPT_LOADER,
} from "@/lib/protected-script";
import { isBrowserRequest, obfuscateScript } from "@/lib/lua-obfuscator";
import { safeGet, safeSetEx } from "@/lib/redis.server";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "X-Session-Token, Content-Type, Authorization",
  "Cache-Control": "no-store",
};

// Cache fetched upstream script bodies in the Cloudflare Worker edge cache,
// keyed by the upstream URL. Same script served to thousands of users => 1 origin fetch.
const UPSTREAM_CACHE_TTL = 900; // 15 minutes

// app_settings.script_content is a single global row read on every fallback
// request. Cache it in Redis so bursts of executors don't each hit the DB.
const SETTINGS_CACHE_KEY = "settings:script_content:v1";
const SETTINGS_CACHE_TTL = 120; // seconds

async function fetchUpstreamCached(scriptUrl: string): Promise<{ ok: boolean; status: number; body: string }> {
  const cacheKey = new Request(`https://script-cache.internal/${encodeURIComponent(scriptUrl)}`, { method: "GET" });
  const cache = (globalThis as any).caches?.default as Cache | undefined;

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return { ok: true, status: 200, body: await hit.text() };
    }
  }

  const upstream = await fetch(scriptUrl, {
    headers: {
      "User-Agent": "Lovable-HWID-Script/1.0",
      Accept: "text/plain, text/*;q=0.9, */*;q=0.1",
    },
    redirect: "follow",
  });

  if (!upstream.ok) {
    return { ok: false, status: upstream.status, body: "" };
  }

  const body = await upstream.text();

  if (cache) {
    const cached = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": `public, max-age=${UPSTREAM_CACHE_TTL}`,
      },
    });
    // Don't await — fire-and-forget cache write
    cache.put(cacheKey, cached).catch(() => {});
  }

  return { ok: true, status: 200, body };
}

export const Route = createFileRoute("/api/public/script")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers }),
      GET: async ({ request }) => {
        try {
          // Block browser/HTML callers — this endpoint is for Roblox HttpGet only.
          if (isBrowserRequest(request)) {
            return new Response(
              `<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body style="background:#0a0a0a;color:#ff4444;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:monospace;font-size:1.5rem;text-align:center"><div style="padding:2rem;border:1px solid #ff4444;border-radius:8px">&#9940; Access Denied<br><small style="color:#666;font-size:0.8rem">This endpoint is not accessible via browser.</small></div></body></html>`,
              { status: 403, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
            );
          }

          const token = request.headers.get("x-session-token");
          if (!token) {
            return new Response("missing token", { status: 401, headers });
          }

          const { data: session, error } = await supabaseAdmin
            .from("hwid_sessions")
            .select("hwid, status, session_token, session_token_created_at, last_game_id")
            .eq("session_token", token)
            .maybeSingle();

          if (
            error ||
            !session ||
            session.status !== "active" ||
            !session.session_token_created_at ||
            new Date(session.session_token_created_at).getTime() + 30 * 60 * 1000 < Date.now()
          ) {
            return new Response("invalid token", { status: 401, headers });
          }

          // Per-game free-session scripts (name / timer / url or inline vault body), pushed
          // from the key system. A valid live session + this game unlocks the picked script;
          // the protected body is served inline here (never as a public URL).
          const reqUrl = new URL(request.url);
          const pickedId = (reqUrl.searchParams.get("s") || "").trim();
          if (session.last_game_id) {
            const { data: gameRow } = await supabaseAdmin
              .from("allowed_games")
              .select("fs_scripts, enabled, is_paid")
              .eq("game_id", String(session.last_game_id))
              .maybeSingle();
            const list = Array.isArray((gameRow as any)?.fs_scripts) ? ((gameRow as any).fs_scripts as any[]) : [];
            if (gameRow && (gameRow as any).enabled !== false && list.length > 0) {
              // Pick by id when provided, else the first enabled free-session script.
              const chosen = (pickedId && list.find((s) => s && s.id === pickedId)) || list[0];
              if (chosen) {
                // Inline vault body — already stored obfuscated; serve verbatim.
                if (chosen.body && typeof chosen.body === "string") {
                  return new Response(chosen.body, {
                    status: 200,
                    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
                  });
                }
                // URL-backed free script — fetch upstream and serve VERBATIM by default.
                // Obfuscation is OPT-IN per script (chosen.obfuscate === true); it is never
                // applied automatically. The obfuscator is now UTF-8-safe if you do enable it.
                if (chosen.url && typeof chosen.url === "string") {
                  const up = await fetchUpstreamCached(chosen.url);
                  if (!up.ok) {
                    return new Response(`script source failed (${up.status})`, {
                      status: 502,
                      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
                    });
                  }
                  const out = (chosen as any).obfuscate === true ? obfuscateScript(up.body) : up.body;
                  return new Response(out, {
                    status: 200,
                    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
                  });
                }
              }
            }
          }

          const tokenData = { script_url: null as string | null };
          const scriptUrl = typeof tokenData.script_url === "string" ? tokenData.script_url.trim() : "";

          if (scriptUrl === PAID_SCRIPT_SENTINEL) {
            return new Response(obfuscateScript(PAID_SCRIPT_LOADER), {
              status: 200,
              headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
            });
          }

          if (scriptUrl === DISABLED_SCRIPT_SENTINEL) {
            return new Response(obfuscateScript(DISABLED_SCRIPT_LOADER), {
              status: 200,
              headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
            });
          }

          if (scriptUrl) {
            const upstream = await fetchUpstreamCached(scriptUrl);
            if (!upstream.ok) {
              return new Response(`script source failed (${upstream.status})`, {
                status: 502,
                headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
              });
            }
            return new Response(obfuscateScript(upstream.body), {
              status: 200,
              headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
            });
          }

          let script = await safeGet<string>(SETTINGS_CACHE_KEY);
          if (!script) {
            const { data: settings } = await supabaseAdmin
              .from("app_settings")
              .select("script_content")
              .eq("id", 1)
              .maybeSingle();

            script = typeof (settings as { script_content?: unknown } | null)?.script_content === "string"
              ? ((settings as { script_content: string }).script_content || SCRIPT_CONTENT)
              : SCRIPT_CONTENT;
            await safeSetEx(SETTINGS_CACHE_KEY, SETTINGS_CACHE_TTL, script);
          }

          return new Response(obfuscateScript(script), {
            status: 200,
            headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
          });
        } catch {
          return new Response("script endpoint error", { status: 500, headers });
        }
      },
    },
  },
});
