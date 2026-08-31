import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Activity, Clock, Shield, RefreshCw, Copy, Check, Ban, Settings as SettingsIcon, Trash2, Gamepad2, Power, Upload, Download, DollarSign, Sparkles, AlertTriangle, ChevronRight, Search, X as XIcon, ArrowUp, ArrowDown, Pencil, LogOut, KeyRound, BookOpen, LayoutDashboard, ExternalLink, Eye, Timer, Link2, RotateCcw, Infinity as InfinityIcon, Globe, Play } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { fetchGameName, fetchScriptSource, updateAppSettings, runGrowthAlerts } from "@/lib/roblox.functions";
import { deleteAllowedGames, listAllowedGames, updateAllowedGame, upsertAllowedGames, fetchRemoteGameList, DEFAULT_GAME_LIST_API } from "@/lib/games.functions";
import { fetchDashboard, clearHwidSession, banHwid as banHwidFn, unbanHwid as unbanHwidFn, saveScriptContent } from "@/lib/admin-data.functions";
import { combowickAdmin } from "@/lib/combowick.functions";
import bundledScripts from "@/data/script-bundle.json";
import { SCRIPT_CONTENT, SCRIPT_ENDPOINT_PATH, KNOWN_FREE_SCRIPTS, PAID_SCRIPT_SENTINEL, DISABLED_SCRIPT_SENTINEL } from "@/lib/protected-script";
import { useAuth } from "@/lib/auth";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { APP_SETTINGS_LIMITS } from "@/lib/settings-validation";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Analytics recording is disabled to save backend credits — tab hidden entirely.
const ANALYTICS_DISABLED = true;

export const Route = createFileRoute("/admin")({
  component: AdminGate,
  head: () => ({
    meta: [
      { title: "Admin Dashboard — HWID Sessions" },
      { name: "description", content: "Manage HWID sessions, bans, games, settings, and API access." },
      { property: "og:title", content: "Admin Dashboard — HWID Sessions" },
      { property: "og:description", content: "Manage HWID sessions, bans, games, settings, and API access." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function AdminGate() {
  const { loading, allowed } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 text-center">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Not authorized</h1>
          <p className="mt-2 text-sm text-muted-foreground">Enter the site password to continue.</p>
          <Link to="/" className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Go to unlock</Link>
        </div>
      </div>
    );
  }
  return <AdminDashboard />;
}

const APP_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const CHECK_ENDPOINT = `${APP_ORIGIN}/api/check`;
const SCRIPTS_ENDPOINT = `${APP_ORIGIN}/api/scripts`;
const SCRIPT_ENDPOINT = `${APP_ORIGIN}${SCRIPT_ENDPOINT_PATH}`;
const BUNDLED_SCRIPT_MAP = new Map(
  (bundledScripts as Array<{ game_id: string; script_url: string | null; is_paid?: boolean }>)
    .map((row) => [row.game_id, row.script_url] as const),
);

type Row = {
  hwid: string;
  session_start: string | null;
  cooldown_start: string | null;
  status: string;
  created_at: string;
  last_script_url?: string | null;
  last_game_id?: string | null;
};
type Ban = { hwid: string; reason: string | null; banned_at: string };
type Settings = {
  session_seconds: number;
  cooldown_seconds: number;
  throttle_seconds: number;
  kill_switch?: boolean;
  auto_ban_threshold?: number;
  script_content?: string;
  stickiness_green?: number;
  stickiness_yellow?: number;
  retention_d1_green?: number;
  retention_d1_yellow?: number;
  retention_d7_green?: number;
  retention_d7_yellow?: number;
  wau_drop_alert_pct?: number;
  dau_drop_alert_pct?: number;
  retention_drop_alert_pct?: number;
};
type Game = { game_id: string; name: string | null; enabled: boolean; added_at: string; is_paid?: boolean; no_timer?: boolean; script_url?: string | null; session_seconds?: number | null; cooldown_seconds?: number | null; universe_id?: string | null };

function fmt(s: number) {
  if (s <= 0) return "expired";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function computeRemaining(row: Row, now: number, cfg: Settings): number {
  if (row.status === "active" && row.session_start)
    return Math.max(0, cfg.session_seconds - Math.floor((now - parseTs(row.session_start)) / 1000));
  if (row.status === "cooldown" && row.cooldown_start)
    return Math.max(0, cfg.cooldown_seconds - Math.floor((now - parseTs(row.cooldown_start)) / 1000));
  return 0;
}

// Robust timestamp parser. Postgres timestamptz can come back as
// "2026-05-17 21:16:43.269598+00" (space separator, "+00" suffix), which
// some browsers parse as local time, producing wildly wrong remaining
// values. Normalize to ISO before handing to Date.
function parseTs(s: string): number {
  let v = s.trim().replace(" ", "T");
  // "+00" -> "+00:00", bare "+0000" stays valid for Date.parse
  if (/[+-]\d{2}$/.test(v)) v = v + ":00";
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : Date.now();
}

function AdminDashboard() {
  const [rows, setRows] = useState<Row[]>([]);
  const [bans, setBans] = useState<Ban[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [cfg, setCfg] = useState<Settings>({ session_seconds: 1800, cooldown_seconds: 18000, throttle_seconds: 2, kill_switch: false, auto_ban_threshold: 0 });
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<"sessions" | "bans" | "games" | "analytics" | "settings" | "credentials" | "docs" | "publicapi">("sessions");
  const [clearHwid, setClearHwid] = useState("");
  const [hwidScriptUrl, setHwidScriptUrl] = useState<Record<string, string | null>>({});
  const [sessionLimit, setSessionLimit] = useState(20);
  const [totalSessions, setTotalSessions] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [cooldownCount, setCooldownCount] = useState(0);
  const [searchHwid, setSearchHwid] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "cooldown">("all");
  const [gameFilter, setGameFilter] = useState<string>("all"); // "all" | game_id
  const listGames = useServerFn(listAllowedGames);
  const loadDashboard = useServerFn(fetchDashboard);
  const clearSessionFn = useServerFn(clearHwidSession);
  const banFn = useServerFn(banHwidFn);

  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "remaining">("newest");

  async function load() {
    const term = searchHwid.trim();
    const [dash, gamesResult] = await Promise.all([
      loadDashboard({ data: { term, statusFilter, sessionLimit } }),
      listGames({ data: undefined }),
    ]);
    setRows((dash.rows ?? []) as Row[]);
    setTotalSessions(dash.totalSessions ?? 0);
    setActiveCount(dash.activeCount ?? 0);
    setCooldownCount(dash.cooldownCount ?? 0);
    setBans(((dash.bans ?? []) as unknown) as Ban[]);
    setGames((gamesResult ?? []) as Game[]);
    if (dash.settings) setCfg((dash.settings as unknown) as Settings);
    const latest: Record<string, string | null> = {};
    for (const r of ((dash.history ?? []) as unknown) as Array<{ hwid: string; script_url: string | null }>) {
      if (!(r.hwid in latest)) latest[r.hwid] = r.script_url;
    }
    // Fall back to last_script_url stored on the hwid_sessions row itself —
    // this survives session/cooldown expiry and `sessions` cleanup, so the
    // game name keeps showing in the dashboard even after the timer hits 0.
    for (const r of (dash.rows ?? []) as Row[]) {
      if (latest[r.hwid] == null && r.last_script_url) latest[r.hwid] = r.last_script_url;
    }
    setHwidScriptUrl(latest);
    setLoading(false);
  }

  async function clearHwidEverywhere(hwid: string) {
    const value = hwid.trim();
    if (!value) return;
    await clearSessionFn({ data: { hwid: value } });
    setClearHwid("");
    load();
  }

  useEffect(() => {
    load();
    const t = setInterval(() => setNow(Date.now()), 1000);
    // The password gate is only a cookie (not a Supabase login), so realtime over
    // the anon key can't read these tables. Poll the gated server fn instead.
    const poll = setInterval(() => { load(); }, 5000);
    return () => { clearInterval(t); clearInterval(poll); };
  }, [sessionLimit, searchHwid, statusFilter]);


  const { signOut } = useAuth();

  // Apply client-side game filter + sort on top of the server-fetched page of rows.
  const visibleRows: Row[] = (() => {
    let list = rows.slice();
    if (gameFilter !== "all") {
      const targetUrl = gameFilter === "__none__"
        ? null
        : (games.find((g) => g.game_id === gameFilter)?.script_url ?? null);
      list = list.filter((r) => {
        const url = hwidScriptUrl[r.hwid] ?? null;
        if (gameFilter === "__none__") return !url;
        return targetUrl != null && url === targetUrl;
      });
    }
    if (sortBy === "oldest") {
      list.sort((a, b) => {
        const ax = a.session_start ?? a.cooldown_start ?? "";
        const bx = b.session_start ?? b.cooldown_start ?? "";
        return ax.localeCompare(bx);
      });
    } else if (sortBy === "remaining") {
      list.sort((a, b) => computeRemaining(b, now, cfg) - computeRemaining(a, now, cfg));
    }
    return list;
  })();

  function exportSessionsCsv(list: Row[]) {
    const header = ["hwid", "status", "game", "started", "remaining_seconds"];
    const lines = [header.join(",")];
    for (const r of list) {
      const url = hwidScriptUrl[r.hwid] ?? null;
      const linkedGame = url ? games.find((g) => (g.script_url ?? "") === url) : undefined;
      const game = linkedGame && ((linkedGame.session_seconds != null) || (linkedGame.cooldown_seconds != null)) ? linkedGame : undefined;
      const effectiveCfg: Settings = game ? { ...cfg, session_seconds: game.session_seconds ?? cfg.session_seconds, cooldown_seconds: game.cooldown_seconds ?? cfg.cooldown_seconds } : cfg;
      const remaining = computeRemaining(r, now, effectiveCfg);
      const start = r.session_start ?? r.cooldown_start ?? "";
      const gameName = linkedGame ? (linkedGame.name ?? linkedGame.game_id) : "";
      const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
      lines.push([esc(r.hwid), esc(r.status), esc(gameName), esc(start), String(remaining)].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hwid-sessions-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${list.length} ${list.length === 1 ? "row" : "rows"}`);
  }

  const navItems = [
    { id: "sessions" as const, label: "Sessions", icon: Activity },
    { id: "bans" as const, label: "Bans", icon: Ban },
    { id: "games" as const, label: "Games", icon: Gamepad2 },
    { id: "analytics" as const, label: "Analytics", icon: LayoutDashboard },
    { id: "settings" as const, label: "Settings", icon: SettingsIcon },
    { id: "credentials" as const, label: "Credentials", icon: KeyRound },
    { id: "docs" as const, label: "API Docs", icon: BookOpen },
    { id: "publicapi" as const, label: "Public API", icon: Globe },
  ].filter((n) => !(n.id === "analytics" && (ANALYTICS_DISABLED)));

  // If a restricted user is somehow on the analytics tab, bounce them.
  useEffect(() => {
    if (tab === "analytics" && (ANALYTICS_DISABLED)) {
      setTab("sessions");
    }
  }, [tab]);

  const currentNav = navItems.find((n) => n.id === tab) ?? navItems[0];

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[260px_1fr]">
      {/* Sidebar */}
      <aside className="hidden lg:flex sticky top-0 h-screen flex-col border-r border-border bg-sidebar/80 backdrop-blur-xl">
        <Link to="/" className="flex items-center gap-2.5 px-6 py-5 border-b border-border">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-[image:var(--gradient-primary)] shadow-[var(--shadow-elegant)]">
            <Shield className="h-5 w-5 text-primary-foreground" />
          </div>
          <div className="leading-tight">
            <div className="font-display text-sm font-semibold">HWID Sessions</div>
            <div className="text-[11px] text-muted-foreground">Admin Console</div>
          </div>
        </Link>
        <nav className="flex-1 px-3 py-4 space-y-1">
          <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Manage</div>
          {navItems.map((n) => {
            const Icon = n.icon;
            const active = tab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_oklch(0.66_0.21_280/0.3)]"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? "text-primary" : ""}`} />
                <span className="flex-1 text-left">{n.label}</span>
                {active && <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_currentColor]" />}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <div className="rounded-lg bg-sidebar-accent/40 p-3 text-xs">
            <div className="text-muted-foreground">Access</div>
            <div className="mt-0.5 truncate font-medium text-foreground">Unlocked</div>
            <button
              onClick={() => signOut()}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/40"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-background/70 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-4 px-6 py-4 lg:px-10">
            <div className="flex items-center gap-3 min-w-0">
              <Link to="/" className="flex items-center gap-2 lg:hidden">
                <Shield className="h-5 w-5 text-primary" />
                <span className="font-display font-semibold">HWID</span>
              </Link>
              <div className="hidden lg:flex items-center gap-2 text-sm text-muted-foreground">
                <LayoutDashboard className="h-4 w-4" />
                <span>Dashboard</span>
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="text-foreground font-medium">{currentNav.label}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden sm:flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs">
                <span className="h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_currentColor]" />
                <span className="text-muted-foreground">Live</span>
              </div>
              <button onClick={load} className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:border-primary/50 transition">
                <RefreshCw className="h-4 w-4" /> Refresh
              </button>
            </div>
          </div>
          {/* Mobile tab nav */}
          <div className="lg:hidden flex gap-1 overflow-x-auto px-4 pb-3">
            {navItems.map((n) => {
              const Icon = n.icon;
              const active = tab === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setTab(n.id)}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" /> {n.label}
                </button>
              );
            })}
          </div>
        </header>

        <main className="flex-1 px-6 py-8 lg:px-10 lg:py-10">
          <div className="mb-8">
            <h1 className="font-display text-3xl font-semibold tracking-tight">{currentNav.label}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {tab === "sessions" && "Live — updates instantly when sessions change. Timers tick every second."}
              {tab === "bans" && "HWIDs blocked from the RPC. Active sessions are wiped on ban."}
              {tab === "games" && "Manage allowed games and per-game timer overrides."}
              {tab === "analytics" && "Daily traffic — checks, sessions, expirations. Auto-recorded by the cleanup cron."}
              {tab === "settings" && "Global session, cooldown, and kill-switch configuration."}
              {tab === "credentials" && "Direct database credentials for your Roblox script."}
              {tab === "docs" && "REST and RPC reference for integrating with this backend."}
              {tab === "publicapi" && "No-auth public endpoints — test them live before integrating."}
            </p>
          </div>

          {tab === "sessions" && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <Stat label="Active sessions" value={activeCount} icon={<Activity className="h-5 w-5" />} accent="text-primary" />
              <Stat label="On cooldown" value={cooldownCount} icon={<Clock className="h-5 w-5" />} accent="text-accent" />
              <Stat label="Total tracked" value={totalSessions} icon={<Shield className="h-5 w-5" />} accent="text-muted-foreground" />
            </div>
            <div className="mt-6 rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-primary" />
                <h2 className="text-base font-semibold">Clear HWID manually</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Paste the exact HWID printed in your Roblox output. Wipes both the cooldown/session row and any one-time script tokens.</p>
              <div className="mt-4 grid gap-2 md:grid-cols-[1fr_auto]">
                <Input value={clearHwid} onChange={(e) => setClearHwid(e.target.value)} placeholder="Paste HWID…" className="font-mono" />
                <Button onClick={() => clearHwidEverywhere(clearHwid)} disabled={!clearHwid.trim()} variant="outline">
                  <Trash2 className="h-4 w-4" /> Clear
                </Button>
              </div>
            </div>
            <div className="mt-6 rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-primary" />
                <h2 className="text-base font-semibold">Search & filter</h2>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto_auto_auto]">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchHwid}
                    onChange={(e) => { setSearchHwid(e.target.value); setSessionLimit(20); }}
                    placeholder="Search HWID (partial match)…"
                    className="pl-8 font-mono"
                  />
                  {searchHwid && (
                    <button
                      onClick={() => setSearchHwid("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label="Clear search"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value as any); setSessionLimit(20); }}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="all">All statuses</option>
                  <option value="active">Active only</option>
                  <option value="cooldown">Cooldown only</option>
                </select>
                <select
                  value={gameFilter}
                  onChange={(e) => setGameFilter(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm max-w-[220px]"
                  title="Filter by game (matches via last session's script URL)"
                >
                  <option value="all">All games</option>
                  <option value="__none__">No linked game</option>
                  {games.map((g) => (
                    <option key={g.game_id} value={g.game_id}>{g.name ?? g.game_id}</option>
                  ))}
                </select>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="remaining">Time remaining</option>
                </select>
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchHwid(""); setStatusFilter("all"); setGameFilter("all"); setSortBy("newest"); setSessionLimit(20);
                  }}
                  disabled={!searchHwid && statusFilter === "all" && gameFilter === "all" && sortBy === "newest"}
                >
                  <RotateCcw className="h-4 w-4" /> Reset
                </Button>
              </div>
            </div>
            <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-secondary/30 px-4 py-2.5">
                <div className="text-xs text-muted-foreground">
                  {(() => {
                    const visible = visibleRows.length;
                    return `Showing ${visible} ${visible === 1 ? "session" : "sessions"}${(searchHwid || statusFilter !== "all" || gameFilter !== "all") ? " (filtered)" : ""}`;
                  })()}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => load()} title="Refresh">
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => exportSessionsCsv(visibleRows)} disabled={visibleRows.length === 0}>
                    <Download className="h-3.5 w-3.5" /> Export CSV
                  </Button>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr><th className="px-4 py-3">HWID</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Game</th><th className="px-4 py-3">Time remaining</th><th className="px-4 py-3">Started</th><th className="px-4 py-3"></th></tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
                  ) : visibleRows.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      {(searchHwid || statusFilter !== "all" || gameFilter !== "all") ? "No sessions match the current filters." : "No sessions yet."}
                    </td></tr>
                  ) : visibleRows.map((r) => {
                    const url = hwidScriptUrl[r.hwid];
                    let linkedGame = url ? games.find((g) => (g.script_url ?? "") === url) : undefined;
                    // Fall back to last_game_id when the URL lookup misses
                    // (e.g. paid sentinel, disabled loader, or URL changed).
                    if (!linkedGame && r.last_game_id) {
                      linkedGame = games.find((g) => g.game_id === r.last_game_id);
                    }
                    const game = linkedGame && ((linkedGame.session_seconds != null) || (linkedGame.cooldown_seconds != null)) ? linkedGame : undefined;
                    const effectiveCfg: Settings = game ? {
                      ...cfg,
                      session_seconds: game.session_seconds ?? cfg.session_seconds,
                      cooldown_seconds: game.cooldown_seconds ?? cfg.cooldown_seconds,
                    } : cfg;
                    const remaining = computeRemaining(r, now, effectiveCfg);
                    const start = r.session_start ?? r.cooldown_start;
                    return (
                      <tr key={r.hwid} className="border-t border-border">
                        <td className="px-4 py-3 font-mono text-xs">
                          <div className="flex items-center gap-2">
                            <span className="break-all">{r.hwid}</span>
                            <button
                              onClick={() => { navigator.clipboard.writeText(r.hwid); toast.success("HWID copied"); }}
                              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                              title="Copy HWID"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={r.status === "active" ? "rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary" : "rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"}>{r.status}</span>
                          {game && (
                            <span
                              className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400"
                              title={`Per-game timer from ${game.name ?? game.game_id}: ${game.session_seconds != null ? `${Math.round(game.session_seconds/60)}m session` : "default session"}${game.cooldown_seconds != null ? `, ${game.cooldown_seconds}s cooldown` : ""}`}
                            >
                              per-game · {game.name ?? game.game_id}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {linkedGame ? (
                            <span className="font-medium text-foreground">{linkedGame.name ?? linkedGame.game_id}</span>
                          ) : (
                            <span className="italic">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono">{fmt(remaining)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{start ? new Date(start).toLocaleString() : "—"}</td>
                        <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                          <button
                            onClick={async () => {
                              if (!confirm(`Delete session for HWID ${r.hwid}? This wipes their cooldown/session and lets them start fresh.`)) return;
                              await clearHwidEverywhere(r.hwid);
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-primary/50"
                          >
                            <Trash2 className="h-3 w-3" /> Delete
                          </button>
                          <button
                            onClick={async () => {
                              if (!confirm(`Ban HWID ${r.hwid}?`)) return;
                              await banFn({ data: { hwid: r.hwid, reason: "Banned from dashboard" } });
                              load();
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive hover:bg-destructive/20"
                          >
                            <Ban className="h-3 w-3" /> Ban
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!loading && totalSessions > rows.length && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <span className="text-xs text-muted-foreground">
                  Showing {rows.length} of {totalSessions}
                </span>
                <Button variant="outline" size="sm" onClick={() => setSessionLimit((n) => n + 20)}>
                  Load 20 more
                </Button>
              </div>
            )}
          </>
        )}

        {tab === "bans" && <BansTab bans={bans} reload={load} />}
        {tab === "games" && <GamesTab games={games} reload={load} cfg={cfg} />}
        {tab === "settings" && <SettingsTab cfg={cfg} reload={load} />}
        {tab === "analytics" && !ANALYTICS_DISABLED && <AnalyticsTab cfg={cfg} />}

        {tab === "credentials" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-card p-6">
              <h2 className="text-lg font-semibold">Vercel API credentials</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                This deployment exposes the API from the same Vercel origin. Do not embed server secrets in Roblox scripts; the API issues short-lived session tokens.
              </p>
              <div className="mt-5 space-y-4">
                <CredField label="API Base URL" value={APP_ORIGIN || "https://your-project.vercel.app"} />
                <CredField label="HWID Check Endpoint" value={CHECK_ENDPOINT || "/api/check"} mono />
                <CredField label="Script Map Endpoint" value={SCRIPTS_ENDPOINT || "/api/scripts"} mono />
              </div>
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200/90">
              The anon key is safe to embed in client scripts — all session logic and validation runs server-side via the <code>check_hwid</code> RPC.
            </div>
          </div>
        )}

        {tab === "docs" && <ApiDocs />}
        {tab === "publicapi" && <PublicApiTab />}
        </main>
      </div>
    </div>
  );
}

function BansTab({ bans, reload }: { bans: Ban[]; reload: () => void }) {
  const [hwid, setHwid] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const banFn = useServerFn(banHwidFn);
  const unbanFn = useServerFn(unbanHwidFn);

  async function add() {
    if (!hwid.trim()) return;
    setBusy(true);
    const value = hwid.trim();
    try {
      await banFn({ data: { hwid: value, reason: reason.trim() || null } });
      setHwid(""); setReason("");
    } finally {
      setBusy(false);
    }
    reload();
  }
  async function remove(h: string) {
    if (!confirm(`Unban ${h}?`)) return;
    await unbanFn({ data: { hwid: h } });
    reload();
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Ban className="h-4 w-4 text-destructive" />
          <h2 className="text-base font-semibold">Ban a HWID</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Banned HWIDs are blocked from the RPC instantly, and any active session is wiped.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">HWID</Label>
            <Input value={hwid} onChange={(e) => setHwid(e.target.value)} placeholder="Paste HWID…" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Reason <span className="text-muted-foreground/60">(optional)</span></Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. exploiting" />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={add} disabled={busy || !hwid.trim()} variant="destructive">
            <Ban className="h-4 w-4" /> {busy ? "Banning…" : "Ban HWID"}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr><th className="px-4 py-3">HWID</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3">Banned at</th><th className="px-4 py-3"></th></tr>
          </thead>
          <tbody>
            {bans.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No banned HWIDs.</td></tr>
            ) : bans.map((b) => (
              <tr key={b.hwid} className="border-t border-border">
                <td className="px-4 py-3 font-mono text-xs">{b.hwid}</td>
                <td className="px-4 py-3 text-muted-foreground">{b.reason || "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">{new Date(b.banned_at).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => remove(b.hwid)} className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-primary/50">
                    <Trash2 className="h-3 w-3" /> Unban
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GamesTab({ games, reload, cfg }: { games: Game[]; reload: () => void; cfg: Settings }) {
  const [gameId, setGameId] = useState("");
  const [name, setName] = useState("");
  const [scriptUrl, setScriptUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [scriptContent, setScriptContent] = useState(cfg.script_content ?? SCRIPT_CONTENT);
  const [scriptBusy, setScriptBusy] = useState(false);
  const [scriptSaved, setScriptSaved] = useState(false);
  // Inline-edit state (per row)
  const [expandedId, setExpandedId] = useState<string>("");
  const [editUrl, setEditUrl] = useState<string>("");
  const [editSessionMin, setEditSessionMin] = useState<string>("");
  const [editCooldownSec, setEditCooldownSec] = useState<string>("");
  const [savingTimersId, setSavingTimersId] = useState<string>("");
  const [previewBody, setPreviewBody] = useState<string>("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [savingId, setSavingId] = useState<string>("");
  const [applyToUniverse, setApplyToUniverse] = useState<boolean>(false);
  // Search / filter / sort / bulk
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "free" | "paid">("all");
  const [sortKey, setSortKey] = useState<"added_at" | "name" | "game_id">("added_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lookup = useServerFn(fetchGameName);
  const fetchSource = useServerFn(fetchScriptSource);
  const saveScriptFn = useServerFn(saveScriptContent);
  const pullRemoteGames = useServerFn(fetchRemoteGameList);
  // Pagination — render in chunks of 10 to keep the table snappy
  const PAGE_SIZE = 10;
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE);

  useEffect(() => {
    setScriptContent(cfg.script_content ?? SCRIPT_CONTENT);
  }, [cfg.script_content]);

  async function add() {
    const raw = gameId.trim();
    const ids = Array.from(new Set(raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)));
    if (ids.length === 0 || ids.some((x) => !/^\d+$/.test(x))) {
      toast.error("Game ID must be numeric. Separate multiple place IDs with commas or spaces.");
      return;
    }
    setBusy(true);
    const manualName = name.trim();
    const manualUrl = scriptUrl.trim() || null;
    // Resolve each place id -> universe + name in parallel.
    const resolved = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await lookup({ data: { gameId: id } });
          return {
            id,
            gameName: res.gameName || id,
            universeId: (res as { universeId?: string }).universeId ?? "",
          };
        } catch {
          return { id, gameName: id, universeId: "" };
        }
      }),
    );
    // Group ids by universe so siblings share the same script_url / is_paid.
    const universes = new Set(resolved.map((r) => r.universeId).filter(Boolean));
    const rows: Array<Record<string, unknown>> = resolved.map((r, idx) => {
      let inheritedUrl: string | null = manualUrl;
      let inheritedPaid: boolean | undefined;
      if (!inheritedUrl && r.universeId) {
        // sibling already in DB
        const sibling = games.find(
          (x) => x.universe_id === r.universeId && x.game_id !== r.id && (x.script_url ?? "").length > 0,
        );
        if (sibling) {
          inheritedUrl = sibling.script_url ?? null;
          inheritedPaid = sibling.is_paid;
        } else {
          // sibling in this same batch
          const batchSibling = resolved.find(
            (other, otherIdx) => otherIdx !== idx && other.universeId === r.universeId,
          );
          if (batchSibling && manualUrl) inheritedUrl = manualUrl;
        }
      }
      const row: Record<string, unknown> = {
        game_id: r.id,
        name: ids.length === 1 && manualName ? manualName : r.gameName,
        enabled: true,
        script_url: inheritedUrl,
      };
      if (r.universeId) row.universe_id = r.universeId;
      if (typeof inheritedPaid === "boolean") row.is_paid = inheritedPaid;
      return row;
    });
    let importError: string | null = null;
    try {
      await upsertAllowedGames({ data: { rows } });
    } catch (error) {
      importError = error instanceof Error ? error.message : "Game import failed";
    }
    setGameId(""); setName(""); setScriptUrl(""); setBusy(false);
    if (importError) {
      toast.error(importError);
    } else if (ids.length === 1) {
      toast.success(`Added ${rows[0].name}`);
    } else {
      const universeCount = universes.size || 1;
      toast.success(`Added ${ids.length} place IDs across ${universeCount} universe${universeCount === 1 ? "" : "s"}`);
    }
    reload();
  }

  async function fetchName() {
    const id = gameId.trim();
    if (!/^\d+$/.test(id)) return;
    setLookupBusy(true);
    try {
      const res = await lookup({ data: { gameId: id } });
      setName(res.gameName);
    } finally {
      setLookupBusy(false);
    }
  }

  async function toggle(g: Game) {
    const next = !g.enabled;
    await updateAllowedGame({ data: { gameIds: [g.game_id], patch: { enabled: next } } });
    toast.success(next ? "Game enabled" : "Game disabled — will serve MainLoader1");
    reload();
  }
  async function togglePaid(g: Game) {
    const nextPaid = !g.is_paid;
    const update: Record<string, unknown> = { is_paid: nextPaid };
    if (nextPaid) {
      update.script_url = PAID_SCRIPT_SENTINEL;
    } else if (g.script_url === PAID_SCRIPT_SENTINEL) {
      update.script_url = BUNDLED_SCRIPT_MAP.get(g.game_id) ?? KNOWN_FREE_SCRIPTS[g.game_id] ?? null;
    }
    await updateAllowedGame({ data: { gameIds: [g.game_id], patch: update } });
    toast.success(nextPaid ? "Marked as paid" : "Marked as free");
    reload();
  }
  async function toggleNoTimer(g: Game) {
    const next = !g.no_timer;
    const ids = g.universe_id
      ? games.filter((x) => x.universe_id === g.universe_id).map((x) => x.game_id)
      : [g.game_id];
    let error: Error | null = null;
    let affected = ids.length;
    try {
      await updateAllowedGame({ data: { gameIds: ids, patch: { no_timer: next } } });
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("No-timer update failed");
      affected = 0;
    }
    if (error) {
      toast.error(`No-timer update failed: ${error.message}`);
      return;
    }
    toast.success(
      (next ? "No-timer mode ON — unlimited free access" : "No-timer mode OFF") +
        (affected > 1 ? ` — applied to ${affected} place IDs in this universe` : ""),
    );
    reload();
  }
  async function remove(id: string) {
    if (!confirm(`Remove game ${id}?`)) return;
    await deleteAllowedGames({ data: { gameIds: [id] } });
    toast.success("Game removed");
    reload();
  }
  async function refreshName(id: string) {
    try {
      const res = await lookup({ data: { gameId: id } });
      const patch: Record<string, unknown> = { name: res.gameName };
      const uId = (res as { universeId?: string }).universeId;
      if (uId) patch.universe_id = uId;
      await updateAllowedGame({ data: { gameIds: [id], patch } });
      toast.success(`Name refreshed: ${res.gameName}`);
      reload();
    } catch {
      toast.error("Failed to refresh name");
    }
  }

  function effectiveUrl(g: Game): string {
    return (g.script_url ?? BUNDLED_SCRIPT_MAP.get(g.game_id) ?? "") as string;
  }

  function toggleExpand(g: Game) {
    if (expandedId === g.game_id) {
      setExpandedId("");
      setPreviewBody("");
      return;
    }
  setExpandedId(String(g.game_id));
  setEditUrl(effectiveUrl(g));
    setEditSessionMin(g.session_seconds != null ? String(Math.round(g.session_seconds / 60)) : "");
    setEditCooldownSec(g.cooldown_seconds != null ? String(g.cooldown_seconds) : "");
    setPreviewBody("");
    setApplyToUniverse(false);
  }

  async function saveUrl(g: Game) {
    setSavingId(g.game_id);
    const newUrl = editUrl.trim() || null;
    const isPaid = newUrl === PAID_SCRIPT_SENTINEL;
    const patch: Record<string, unknown> = { script_url: newUrl, is_paid: isPaid };
    const ids = applyToUniverse && g.universe_id
      ? games.filter((x) => x.universe_id === g.universe_id).map((x) => x.game_id)
      : [g.game_id];
    const affected = ids.length;
    let error: Error | null = null;
    try {
      await updateAllowedGame({ data: { gameIds: ids, patch } });
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("Script URL update failed");
    }
    setSavingId("");
    if (error) {
      toast.error(`Save failed: ${error.message}`);
      return;
    }
    toast.success(
      affected > 1
        ? `Script URL applied to ${affected} place IDs in this universe`
        : "Script URL saved",
    );
    reload();
  }

  async function saveTimers(g: Game) {
    const sMinTrim = editSessionMin.trim();
    const cSecTrim = editCooldownSec.trim();
    let sessionVal: number | null = null;
    let cooldownVal: number | null = null;
    if (sMinTrim !== "") {
      const n = Number(sMinTrim);
      if (!Number.isFinite(n) || n < 0) { toast.error("Session minutes must be a non-negative number"); return; }
      sessionVal = Math.floor(n * 60);
    }
    if (cSecTrim !== "") {
      const n = Number(cSecTrim);
      if (!Number.isFinite(n) || n < 0) { toast.error("Cooldown seconds must be a non-negative number"); return; }
      cooldownVal = Math.floor(n);
    }
    setSavingTimersId(g.game_id);
    const ids = g.universe_id
      ? games.filter((x) => x.universe_id === g.universe_id).map((x) => x.game_id)
      : [g.game_id];
    let error: Error | null = null;
    const affected = ids.length;
    try {
      await updateAllowedGame({ data: {
        gameIds: ids,
        patch: { session_seconds: sessionVal, cooldown_seconds: cooldownVal },
      } });
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("Timer update failed");
    }
    setSavingTimersId("");
    if (error) { toast.error(`Save failed: ${error.message}`); return; }
    toast.success(
      (sessionVal == null && cooldownVal == null ? "Cleared overrides" : "Per-game timers saved") +
        (affected > 1 ? ` — applied to ${affected} place IDs in this universe` : ""),
    );
    reload();
  }

  async function previewUrl(url: string) {
    if (!url) {
      setPreviewBody("No URL to preview.");
      return;
    }
    if (url === PAID_SCRIPT_SENTINEL) {
      setPreviewBody("This row uses the built-in paid loader (WicksShop). No remote URL.");
      return;
    }
    if (url === DISABLED_SCRIPT_SENTINEL) {
      setPreviewBody("This row uses the built-in disabled-game loader (MainLoader1). No remote URL.");
      return;
    }
    setPreviewBusy(true);
    try {
      const res = await fetchSource({ data: { url } });
      if (!res.ok) setPreviewBody(`Failed to fetch script (${res.status}) from ${res.finalUrl || url}`);
      else setPreviewBody(res.content || "Script URL returned an empty body.");
    } catch (e) {
      setPreviewBody(`Failed to fetch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPreviewBusy(false);
    }
  }

  // Bulk actions
  async function bulkUpdate(patch: Record<string, unknown>, label: string) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    let error: Error | null = null;
    try {
      await updateAllowedGame({ data: { gameIds: ids, patch } });
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(`${label} failed`);
    }
    if (error) toast.error(`${label} failed: ${error.message}`);
    else toast.success(`${label}: ${ids.length} games`);
    setSelected(new Set());
    reload();
  }
  async function bulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} games?`)) return;
    let error: Error | null = null;
    try {
      await deleteAllowedGames({ data: { gameIds: ids } });
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("Delete failed");
    }
    if (error) toast.error(`Delete failed: ${error.message}`);
    else toast.success(`Deleted ${ids.length} games`);
    setSelected(new Set());
    reload();
  }

  function toggleSort(key: "added_at" | "name" | "game_id") {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  const [fetchAllBusy, setFetchAllBusy] = useState(false);
  const [fetchAllMsg, setFetchAllMsg] = useState<string | null>(null);
  async function fetchAllMissing() {
    const missing = games.filter((g) => !g.name || g.name === g.game_id || !g.universe_id);
    if (missing.length === 0) { setFetchAllMsg("All names and universe IDs are already filled."); return; }
    if (!confirm(`Fetch names + universe IDs for ${missing.length} games from Roblox? This may take a moment.`)) return;
    setFetchAllBusy(true);
    let done = 0;
    for (const g of missing) {
      try {
        const res = await lookup({ data: { gameId: g.game_id } });
        const patch: Record<string, unknown> = {};
        if (res.gameName && res.gameName !== g.game_id) patch.name = res.gameName;
        const uId = (res as { universeId?: string }).universeId;
        if (uId) patch.universe_id = uId;
        if (Object.keys(patch).length > 0) {
          await updateAllowedGame({ data: { gameIds: [g.game_id], patch } });
        }
      } catch {}
      done++;
      setFetchAllMsg(`Fetched ${done}/${missing.length}…`);
      // small gap to be polite to Roblox
      await new Promise((r) => setTimeout(r, 120));
    }
    setFetchAllBusy(false);
    setFetchAllMsg(`Done — processed ${done} games.`);
    toast.success(`Processed ${done} games`);
    reload();
  }

  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [apiUrl, setApiUrl] = useState(DEFAULT_GAME_LIST_API);
  const fileRef = useRef<HTMLInputElement>(null);

  type ParsedRow = { id: string; is_paid?: boolean; name?: string; script_url?: string | null; enabled?: boolean; added_at?: string };
  type ImportContext = { inferredPaid?: boolean };

  async function populateNamesForGames(gameIds: string[]) {
    let completed = 0;
    let updated = 0;
    for (const id of gameIds) {
      try {
        const result = await lookup({ data: { gameId: id } });
        const patch: Record<string, unknown> = {};
        if (result.gameName && result.gameName !== id) patch.name = result.gameName;
        const universeId = (result as { universeId?: string }).universeId;
        if (universeId) patch.universe_id = universeId;
        if (Object.keys(patch).length > 0) {
          await updateAllowedGame({ data: { gameIds: [id], patch } });
          updated++;
        }
      } catch {
        // Keep the imported row when Roblox does not return metadata for an ID.
      }
      completed++;
      setImportMsg(`Imported ${gameIds.length} games. Fetching names ${completed}/${gameIds.length}…`);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return updated;
  }

  async function bulkUpsert(rows: ParsedRow[], label: string) {
    const merged = new Map<string, ParsedRow>();
    for (const row of rows) {
      const id = String(row.id).trim();
      if (!/^\d+$/.test(id)) continue;
      const existing = merged.get(id) ?? { id, enabled: true };
      merged.set(id, {
        id,
        is_paid: typeof row.is_paid === "boolean" ? row.is_paid : existing.is_paid,
        name: row.name?.trim() || existing.name,
        script_url:
          typeof row.script_url === "string"
            ? row.script_url.trim() || existing.script_url
            : existing.script_url,
        enabled: typeof row.enabled === "boolean" ? row.enabled : existing.enabled,
        added_at: row.added_at ?? existing.added_at,
      });
    }
    const clean = Array.from(merged.values());
    if (clean.length === 0) {
      setImportMsg("No valid numeric IDs found.");
      return;
    }
    setImportBusy(true);
    setImportMsg(`Importing ${clean.length} games from ${label}…`);
    const chunkSize = 200;
    let inserted = 0;
    for (let i = 0; i < clean.length; i += chunkSize) {
      const chunk = clean.slice(i, i + chunkSize).map((r) => {
        const row: Record<string, unknown> = { game_id: r.id, enabled: r.enabled ?? true };
        if (typeof r.is_paid === "boolean") row.is_paid = r.is_paid;
        if (r.name) row.name = r.name;
        if (typeof r.script_url === "string") row.script_url = r.script_url;
        if (typeof r.added_at === "string") row.added_at = r.added_at;
        return row;
      });
    try {
      await upsertAllowedGames({ data: { rows: chunk } });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Game import failed";
      setImportMsg(`Error at chunk ${i}: ${message}`);
      setImportBusy(false);
      return;
    }
      inserted += chunk.length;
      setImportMsg(`Imported ${inserted}/${clean.length}…`);
    }
    const importedIds = clean.map((row) => row.id);
    const updatedNames = await populateNamesForGames(importedIds);
    setImportBusy(false);
    setImportMsg(
      updatedNames > 0
        ? `Imported ${inserted} games and populated ${updatedNames} names.`
        : `Imported ${inserted} games. Roblox returned no names for these IDs.`,
    );
    reload();
  }

  function parsePaidFlag(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "paid", "premium", "vip"].includes(normalized)) return true;
      if (["false", "0", "no", "free", "unpaid"].includes(normalized)) return false;
    }
    return undefined;
  }

  function normalizeParsedRow(value: unknown, context: ImportContext = {}): ParsedRow | null {
    if (typeof value === "string" || typeof value === "number") {
      return { id: String(value).trim(), is_paid: context.inferredPaid };
    }
    if (!value || typeof value !== "object") return null;

    const o = value as Record<string, unknown>;
    const id = o.gameId ?? o.game_id ?? o.id ?? o.placeId ?? o.place_id ?? o.place ?? o.placeid ?? o.game;
    if (id == null) return null;

    const idStr = String(id).trim();
    if (!/^\d+$/.test(idStr)) return null;

    const paidRaw = o.isPaid ?? o.is_paid ?? o.paid ?? o.premium ?? o.type ?? o.access ?? o.plan;
    const is_paid = parsePaidFlag(paidRaw) ?? context.inferredPaid;
    const name = typeof o.name === "string"
      ? o.name.trim()
      : typeof o.title === "string"
        ? o.title.trim()
        : typeof o.gameName === "string"
          ? o.gameName.trim()
          : undefined;
    const rawUrlValue =
      o.url ?? o.script_url ?? o.scriptUrl ?? o.raw_url ?? o.rawUrl ?? o.link ?? o.href ?? o.source ?? o.src ?? o.loader_url ?? o.loaderUrl;
    const url = typeof rawUrlValue === "string" ? rawUrlValue.trim() : "";
    const statusRaw = typeof o.status === "string" ? o.status.trim().toLowerCase() : "";
    const enabledRaw = o.enabled ?? o.isEnabled ?? o.active;
    const enabled = typeof enabledRaw === "boolean"
      ? enabledRaw
      : statusRaw
        ? statusRaw !== "disabled" && statusRaw !== "inactive" && statusRaw !== "off"
        : true;

    const finalUrl = is_paid === true
      ? PAID_SCRIPT_SENTINEL
      : (url || KNOWN_FREE_SCRIPTS[idStr] || null);

    return {
      id: idStr,
      is_paid,
      name: name || undefined,
      script_url: finalUrl,
      enabled,
    };
  }

  function extractRows(parsed: unknown, context: ImportContext = {}): ParsedRow[] {
    if (Array.isArray(parsed)) {
      return parsed.flatMap((entry) => extractRows(entry, context));
    }

    const direct = normalizeParsedRow(parsed, context);
    if (direct) return [direct];
    if (!parsed || typeof parsed !== "object") return [];

    const obj = parsed as Record<string, unknown>;
    const rows: ParsedRow[] = [];

    for (const [key, value] of Object.entries(obj)) {
      const normalizedKey = key.trim().toLowerCase();
      const inferredPaid = normalizedKey === "paid" || normalizedKey === "premium"
        ? true
        : normalizedKey === "free"
          ? false
          : context.inferredPaid;

      if (/^\d+$/.test(key)) {
        const mapped = normalizeParsedRow(
          typeof value === "object" && value !== null
            ? { id: key, ...(value as Record<string, unknown>) }
            : { id: key, url: value },
          { inferredPaid },
        );
        if (mapped) rows.push(mapped);
        continue;
      }

      if (Array.isArray(value) || (value && typeof value === "object")) {
        rows.push(...extractRows(value, { inferredPaid }));
      }
    }

    return rows;
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      let rows: ParsedRow[] = [];
      if (f.name.endsWith(".json")) {
        rows = extractRows(JSON.parse(text));
      } else {
        rows = text.split(/[\s,;|]+/).map((s) => s.trim()).filter(Boolean).map((id) => ({ id }));
      }
      await bulkUpsert(rows, f.name);
    } catch (err) {
      setImportMsg(`Failed to parse file: ${(err as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function loadSeed() {
    const bundle = bundledScripts as Array<{ game_id: string; script_url: string | null; is_paid?: boolean; name?: string | null; enabled?: boolean }>;
    if (!confirm(`Import the bundled list of ${bundle.length} games with script URLs?`)) return;
    await bulkUpsert(
      bundle.map((row) => ({
        id: row.game_id,
        script_url: row.script_url,
        is_paid: row.is_paid,
        name: row.name ?? undefined,
        enabled: row.enabled ?? true,
      })),
      "bundled script list",
    );
  }

  async function importFromApi() {
    const url = apiUrl.trim() || DEFAULT_GAME_LIST_API;
    setImportBusy(true);
    setImportMsg(`Fetching game list from ${url}…`);
    let rows: Array<{ game_id: string; script_url: string | null }> = [];
    try {
      const result = await pullRemoteGames({ data: { url } });
      rows = result.rows;
    } catch (err) {
      setImportBusy(false);
      setImportMsg(`API fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setImportBusy(false);
    if (!confirm(`Import ${rows.length} games from the API?`)) {
      setImportMsg(null);
      return;
    }
    // API lists oldest first, newest last — map to increasing timestamps so the
    // table's newest-first sort reflects real API order (distinct added_at per row).
    const base = Date.now();
    await bulkUpsert(
      rows.map((row, i) => ({
        id: row.game_id,
        script_url: row.script_url,
        enabled: true,
        added_at: new Date(base - (rows.length - 1 - i) * 1000).toISOString(),
      })),
      "API game list",
    );
  }

  async function saveScript() {
    setScriptBusy(true);
    try {
      await saveScriptFn({ data: { script_content: scriptContent } });
    } catch (e) {
      setScriptBusy(false);
      toast.error(`Failed to save script: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setScriptBusy(false);
    setScriptSaved(true);
    setTimeout(() => setScriptSaved(false), 2000);
    toast.success("Fallback script saved");
    reload();
  }

  // Derived: filtered + sorted view
  const filtered = games
    .filter((g) => {
      if (statusFilter === "enabled" && !g.enabled) return false;
      if (statusFilter === "disabled" && g.enabled) return false;
      if (typeFilter === "paid" && !g.is_paid) return false;
      if (typeFilter === "free" && g.is_paid) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${g.game_id} ${g.name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortKey === "name") return ((a.name ?? "") > (b.name ?? "") ? 1 : -1) * dir;
      if (sortKey === "game_id") return (a.game_id > b.game_id ? 1 : -1) * dir;
      return (new Date(a.added_at).getTime() - new Date(b.added_at).getTime()) * dir;
    });

  // Reset visible window whenever the filtered result set changes shape
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, statusFilter, typeFilter, sortKey, sortDir, games.length]);

  const visible = filtered.slice(0, visibleCount);
  const remainingCount = Math.max(filtered.length - visible.length, 0);

  // Stats
  const stats = {
    total: games.length,
    enabled: games.filter((g) => g.enabled).length,
    disabled: games.filter((g) => !g.enabled).length,
    paid: games.filter((g) => g.is_paid).length,
    free: games.filter((g) => !g.is_paid).length,
    withUrl: games.filter((g) => effectiveUrl(g)).length,
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((g) => selected.has(g.game_id));
  function toggleAllFiltered() {
    const next = new Set(selected);
    if (allFilteredSelected) filtered.forEach((g) => next.delete(g.game_id));
    else filtered.forEach((g) => next.add(g.game_id));
    setSelected(next);
  }
  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  function SortBtn({ k, label }: { k: "added_at" | "name" | "game_id"; label: string }) {
    return (
      <button onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        {sortKey === k && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Fallback protected script</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          This only serves as a fallback when a game does not have its own script URL.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div className="space-y-3">
            <textarea
              value={scriptContent}
              onChange={(e) => setScriptContent(e.target.value)}
              spellCheck={false}
              className="min-h-[22rem] w-full rounded-lg border border-border bg-background/60 p-4 font-mono text-xs leading-relaxed"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={saveScript}
                disabled={scriptBusy}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {scriptBusy ? "Saving…" : "Save script"}
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(scriptContent)}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-sm hover:border-primary/50"
              >
                <Copy className="h-4 w-4" /> Copy
              </button>
              <button
                onClick={() => setScriptContent(cfg.script_content ?? SCRIPT_CONTENT)}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-sm hover:border-primary/50"
              >
                <RefreshCw className="h-4 w-4" /> Reset
              </button>
              {scriptSaved && <span className="text-sm text-primary">Saved.</span>}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/50 p-4 text-sm">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Served from</div>
            <code className="mt-2 block break-all text-xs text-primary">{SCRIPT_ENDPOINT}</code>
            <p className="mt-3 text-xs text-muted-foreground">
              Disabled games now auto-serve a built-in MainLoader1 loader instead of being blocked.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MiniStat label="Total" value={stats.total} />
        <MiniStat label="Enabled" value={stats.enabled} accent="text-primary" />
        <MiniStat label="Disabled" value={stats.disabled} accent="text-amber-400" />
        <MiniStat label="Paid" value={stats.paid} accent="text-amber-400" />
        <MiniStat label="Free" value={stats.free} />
        <MiniStat label="With URL" value={stats.withUrl} accent="text-primary" />
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Gamepad2 className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold">Add a game</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Add a Roblox place ID — or paste multiple at once (separated by commas, spaces, or new lines) when a game has several place IDs sharing the same universe. The name auto-fetches if blank. Script URL is optional and is shared across all pasted IDs.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Game ID <span className="text-muted-foreground/60">(one or many place IDs)</span></Label>
            <div className="flex gap-2">
              <Input value={gameId} onChange={(e) => setGameId(e.target.value)} placeholder="e.g. 73403837686778, 76889882866148, 98653711640137" className="font-mono" />
              <Button variant="outline" size="default" onClick={fetchName} disabled={lookupBusy || !gameId.trim()} className="shrink-0">
                <Sparkles className="h-3.5 w-3.5" /> {lookupBusy ? "…" : "Fetch"}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Game name <span className="text-muted-foreground/60">(optional)</span></Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Auto-fetched if blank" />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs text-muted-foreground">Script URL <span className="text-muted-foreground/60">(optional)</span></Label>
            <Input value={scriptUrl} onChange={(e) => setScriptUrl(e.target.value)} placeholder="https://raw.githubusercontent.com/.../Script.lua" className="font-mono" />
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button onClick={add} disabled={busy || !gameId.trim()}>
            {busy ? "Adding…" : "Add game"}
          </Button>
        </div>

        <div className="mt-6 border-t border-border pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={loadSeed}
              disabled={importBusy}
              className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
            >
                <Download className="h-4 w-4" /> Import bundled list ({(bundledScripts as Array<unknown>).length})
            </button>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-sm hover:border-primary/50">
              <Upload className="h-4 w-4" /> Upload .json / .txt
              <input ref={fileRef} type="file" accept=".json,.txt,.csv" onChange={onFile} className="hidden" />
            </label>
            <button
              onClick={importFromApi}
              disabled={importBusy}
              className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              <Globe className="h-4 w-4" /> {importBusy ? "Importing…" : "Import from API"}
            </button>
            <button
              onClick={fetchAllMissing}
              disabled={fetchAllBusy}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-sm hover:border-primary/50 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" /> {fetchAllBusy ? "Fetching…" : "Fetch all missing names"}
            </button>
            {(importMsg || fetchAllMsg) && <span className="text-xs text-muted-foreground">{importMsg || fetchAllMsg}</span>}
          </div>
          <div className="mt-3 space-y-1.5">
            <Label className="text-xs text-muted-foreground">Game list API URL</Label>
            <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder={DEFAULT_GAME_LIST_API} className="font-mono text-xs" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Bulk add Roblox place IDs. Accepts flat arrays, nested bundles, keyed objects, and original scripts JSON using fields like <code>gameId</code>, <code>url</code>, <code>scriptUrl</code>, <code>raw_url</code>, <code>type</code>, and <code>isPaid</code>. The built-in bundle now imports the real URLs recovered from your uploaded site export, and paid entries auto-route to the built-in paid loader.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or game ID…"
              className="w-full rounded-md border border-border bg-background/60 pl-9 pr-9 py-2 text-sm"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <XIcon className="h-4 w-4" />
              </button>
            )}
          </div>
          <FilterChips value={statusFilter} onChange={setStatusFilter} options={[{v:"all",l:"All status"},{v:"enabled",l:"Enabled"},{v:"disabled",l:"Disabled"}]} />
          <FilterChips value={typeFilter} onChange={setTypeFilter} options={[{v:"all",l:"All types"},{v:"free",l:"Free"},{v:"paid",l:"Paid"}]} />
          <span className="text-xs text-muted-foreground ml-auto">{filtered.length} of {games.length}</span>
        </div>
        {selected.size > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <span className="text-primary font-medium">{selected.size} selected</span>
            <button onClick={() => bulkUpdate({ enabled: true }, "Enabled")} className="rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-primary/50">Enable</button>
            <button onClick={() => bulkUpdate({ enabled: false }, "Disabled")} className="rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-primary/50">Disable</button>
            <button onClick={() => bulkUpdate({ is_paid: true, script_url: PAID_SCRIPT_SENTINEL }, "Marked paid")} className="rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-primary/50">Mark paid</button>
            <button onClick={() => bulkUpdate({ is_paid: false }, "Marked free")} className="rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-primary/50">Mark free</button>
            <button onClick={bulkDelete} className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive hover:bg-destructive/20">Delete</button>
            <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Clear</button>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-3 w-8">
                <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} />
              </th>
              <th className="px-3 py-3 w-8"></th>
              <th className="px-4 py-3"><SortBtn k="game_id" label="Game ID" /></th>
              <th className="px-4 py-3"><SortBtn k="name" label="Name" /></th>
              <th className="px-4 py-3">Script URL</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"><SortBtn k="added_at" label="Added" /></th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">{games.length === 0 ? "No games added — all games are currently allowed." : "No games match your filters."}</td></tr>
            ) : visible.map((g) => {
              const displayUrl = effectiveUrl(g) || null;
              return (
              <tr key={g.game_id} className="group border-t border-border transition hover:bg-secondary/30">
                <td className="px-3 py-3">
                  <input type="checkbox" checked={selected.has(g.game_id)} onChange={() => toggleOne(g.game_id)} />
                </td>
                <td className="px-3 py-3">
                  <button
                    type="button"
                    onClick={() => toggleExpand(g)}
                    aria-label={`Edit ${g.name || `game ${g.game_id}`}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-xs font-medium text-muted-foreground transition hover:border-primary/50 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="Open game editor"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    <span className="sr-only sm:not-sr-only">Edit</span>
                  </button>
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  <a href={`https://www.roblox.com/games/${g.game_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary">
                    {g.game_id}
                    <ExternalLink className="h-3 w-3 opacity-0 transition group-hover:opacity-60" />
                  </a>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => refreshName(g.game_id)} className="text-left hover:text-primary" title="Click to refresh from Roblox">
                    {g.name || <span className="text-muted-foreground italic">unknown</span>}
                  </button>
                </td>
                <td className="px-4 py-3 max-w-[240px]">
                  <button
                    onClick={() => toggleExpand(g)}
                    className="block w-full truncate text-left font-mono text-xs hover:text-primary"
                    title={displayUrl || "No script URL saved"}
                  >
                    {displayUrl || <span className="text-muted-foreground italic">no url</span>}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => togglePaid(g)} className={g.is_paid ? "inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400 hover:bg-amber-500/25" : "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/80"}>
                    <DollarSign className="h-3 w-3" /> {g.is_paid ? "paid" : "free"}
                  </button>
                  {g.no_timer && (
                    <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400" title="No timer — unlimited access, session/cooldown bypassed">
                      <InfinityIcon className="h-3 w-3" /> no timer
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={g.enabled
                      ? "rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary"
                      : "rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400"}
                    title={g.enabled ? "Serving the saved script URL" : "Serves the built-in MainLoader1 fallback"}
                  >
                    {g.enabled ? "enabled" : "disabled → MainLoader1"}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{new Date(g.added_at).toLocaleString()}</td>
                <td className="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
                  <button onClick={() => toggleExpand(g)} className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-primary/50">
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  <button onClick={() => toggle(g)} className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-primary/50">
                    <Power className="h-3 w-3" /> {g.enabled ? "Disable" : "Enable"}
                  </button>
                  <button onClick={() => remove(g.game_id)} className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 text-xs hover:border-destructive/50 hover:text-destructive">
                    <Trash2 className="h-3 w-3" /> Remove
                  </button>
                </td>
              </tr>
            )})}
          </tbody>
        </table>
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-col items-center gap-2 py-4 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-2">
          <span>
            Showing <span className="font-medium text-foreground">{visible.length}</span> of{" "}
            <span className="font-medium text-foreground">{filtered.length}</span>
            {remainingCount > 0 ? ` · ${remainingCount} hidden to keep things snappy` : " · all loaded"}
          </span>
          {remainingCount > 0 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              >
                Load {Math.min(PAGE_SIZE, remainingCount)} more
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVisibleCount(filtered.length)}
              >
                Load all ({remainingCount})
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Premium edit drawer */}
      <Sheet open={!!expandedId} onOpenChange={(o) => { if (!o) { setExpandedId(""); setPreviewBody(""); } }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto bg-card/95 backdrop-blur-xl border-l border-border p-0">
          {(() => {
            const g = games.find((x) => String(x.game_id) === expandedId);
            if (!g) return null;
            return (
              <>
                <SheetHeader className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur-xl px-6 py-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <SheetTitle className="font-display text-xl truncate">{g.name || "Unnamed game"}</SheetTitle>
                      <SheetDescription className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="font-mono text-muted-foreground">ID {g.game_id}</span>
                        {g.universe_id ? (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary" title="Roblox universe ID — shared by all place IDs of the same game">
                            U {g.universe_id}
                          </span>
                        ) : null}
                        <span className={g.enabled ? "rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary" : "rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-400"}>
                          {g.enabled ? "enabled" : "disabled → MainLoader1"}
                        </span>
                        <span className={g.is_paid ? "rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-400" : "rounded-full bg-muted px-2 py-0.5 text-muted-foreground"}>
                          {g.is_paid ? "paid" : "free"}
                        </span>
                        {g.no_timer && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-400">
                            <InfinityIcon className="h-3 w-3" /> no timer
                          </span>
                        )}
                        <a href={`https://www.roblox.com/games/${g.game_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary">
                          Open on Roblox <ExternalLink className="h-3 w-3" />
                        </a>
                      </SheetDescription>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => toggle(g)}>
                      <Power className="h-3.5 w-3.5" /> {g.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => togglePaid(g)}>
                      <DollarSign className="h-3.5 w-3.5" /> Mark as {g.is_paid ? "free" : "paid"}
                    </Button>
                    <Button size="sm" variant={g.no_timer ? "default" : "outline"} onClick={() => toggleNoTimer(g)}>
                      <InfinityIcon className="h-3.5 w-3.5" /> {g.no_timer ? "Disable no-timer" : "Enable no-timer"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => refreshName(g.game_id)}>
                      <RefreshCw className="h-3.5 w-3.5" /> Refresh name
                    </Button>
                    <Button size="sm" variant="outline" className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30" onClick={() => remove(g.game_id)}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </Button>
                  </div>
                </SheetHeader>

                <div className="px-6 py-6 space-y-8">
                  {/* Script URL section */}
                  <section>
                    <div className="flex items-center gap-2 mb-1">
                      <Link2 className="h-4 w-4 text-primary" />
                      <h3 className="text-sm font-semibold">Script URL</h3>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">Raw URL served to this game when execution is allowed.</p>
                    <textarea
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      spellCheck={false}
                      placeholder="https://raw.githubusercontent.com/.../Script.lua"
                      className="min-h-[6rem] w-full rounded-lg border border-border bg-background/60 p-3 font-mono text-xs leading-relaxed transition focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => saveUrl(g)} disabled={savingId === g.game_id}>
                        {savingId === g.game_id ? "Saving…" : "Save URL"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => previewUrl(editUrl)} disabled={previewBusy}>
                        <Eye className="h-3.5 w-3.5" /> {previewBusy ? "Loading…" : "Preview"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditUrl("")} className="text-muted-foreground hover:text-destructive">
                        Clear
                      </Button>
                    </div>
                    {(() => {
                      const siblings = g.universe_id
                        ? games.filter((x) => x.universe_id === g.universe_id)
                        : [];
                      if (siblings.length <= 1) {
                        return g.universe_id ? null : (
                          <p className="mt-3 text-[11px] text-muted-foreground">
                            No universe ID yet — click "Refresh name" to link this place ID to its Roblox game so you can update siblings together.
                          </p>
                        );
                      }
                      return (
                        <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
                          <label className="flex items-start gap-2 cursor-pointer text-xs">
                            <input
                              type="checkbox"
                              checked={applyToUniverse}
                              onChange={(e) => setApplyToUniverse(e.target.checked)}
                              className="mt-0.5 h-3.5 w-3.5 accent-primary"
                            />
                            <span>
                              <span className="font-medium text-foreground">Apply to all {siblings.length} place IDs of this game</span>
                              <span className="block text-muted-foreground mt-0.5">
                                Updates script URL + paid flag across every place ID sharing universe {g.universe_id}.
                              </span>
                            </span>
                          </label>
                          <ul className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-mono">
                            {siblings.map((s) => (
                              <li
                                key={s.game_id}
                                className={
                                  s.game_id === g.game_id
                                    ? "rounded bg-primary/20 px-1.5 py-0.5 text-primary"
                                    : "rounded bg-background/60 px-1.5 py-0.5 text-muted-foreground"
                                }
                                title={s.name ?? undefined}
                              >
                                {s.game_id}
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
                  </section>

                  <Separator />

                  {/* Per-game timers */}
                  <section>
                    <div className="flex items-center gap-2 mb-1">
                      <Timer className="h-4 w-4 text-primary" />
                      <h3 className="text-sm font-semibold">Per-game timers</h3>
                      <span className="ml-auto text-[10px] text-muted-foreground">6h = 21600s</span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      Leave blank to inherit globals (<span className="font-mono">{Math.round(cfg.session_seconds / 60)} min</span> session, <span className="font-mono">{cfg.cooldown_seconds}s</span> cooldown).
                      {g.universe_id ? " Saving applies to every place ID sharing this universe." : ""}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Session (minutes)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={editSessionMin}
                          onChange={(e) => setEditSessionMin(e.target.value)}
                          placeholder={`default ${Math.round(cfg.session_seconds / 60)}`}
                          className="font-mono"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Cooldown (seconds)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={editCooldownSec}
                          onChange={(e) => setEditCooldownSec(e.target.value)}
                          placeholder={`default ${cfg.cooldown_seconds}`}
                          className="font-mono"
                        />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => saveTimers(g)} disabled={savingTimersId === g.game_id}>
                        {savingTimersId === g.game_id ? "Saving…" : "Save timers"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setEditSessionMin(""); setEditCooldownSec(""); }}>
                        <RotateCcw className="h-3.5 w-3.5" /> Use defaults
                      </Button>
                    </div>
                  </section>

                  <Separator />

                  {/* Preview */}
                  <section>
                    <div className="flex items-center gap-2 mb-1">
                      <Eye className="h-4 w-4 text-primary" />
                      <h3 className="text-sm font-semibold">Script preview</h3>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">Fetched live from the URL above.</p>
                    <pre className="min-h-[8rem] max-h-[24rem] overflow-auto rounded-lg border border-border bg-background/60 p-3 text-[11px] leading-relaxed">
                      <code>{previewBusy ? "Loading…" : (previewBody || 'Click "Preview" above to fetch the script body.')}</code>
                    </pre>
                  </section>
                </div>
              </>
            );
          })()}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

function FilterChips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { v: T; l: string }[] }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-background/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`rounded px-2.5 py-1 text-xs transition ${value === o.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function SettingsTab({ cfg, reload }: { cfg: Settings; reload: () => void }) {
  const saveSettings = useServerFn(updateAppSettings);
  const [sessionMin, setSessionMin] = useState(String(Math.round(cfg.session_seconds / 60)));
  const [cooldownSec, setCooldownSec] = useState(String(cfg.cooldown_seconds));
  const [throttleSec, setThrottleSec] = useState(String(cfg.throttle_seconds));
  const [autoBan, setAutoBan] = useState(String(cfg.auto_ban_threshold ?? 0));
  const [killSwitch, setKillSwitch] = useState(cfg.kill_switch ?? false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const [sg, setSg] = useState(String(cfg.stickiness_green ?? 20));
  const [sy, setSy] = useState(String(cfg.stickiness_yellow ?? 10));
  const [r1g, setR1g] = useState(String(cfg.retention_d1_green ?? 40));
  const [r1y, setR1y] = useState(String(cfg.retention_d1_yellow ?? 20));
  const [r7g, setR7g] = useState(String(cfg.retention_d7_green ?? 20));
  const [r7y, setR7y] = useState(String(cfg.retention_d7_yellow ?? 10));
  const [wauDrop, setWauDrop] = useState(String(cfg.wau_drop_alert_pct ?? 20));
  const [dauDrop, setDauDrop] = useState(String(cfg.dau_drop_alert_pct ?? 30));
  const [retDrop, setRetDrop] = useState(String(cfg.retention_drop_alert_pct ?? 25));
  const [benchBusy, setBenchBusy] = useState(false);
  const [benchSaved, setBenchSaved] = useState(false);

  useEffect(() => {
    setSessionMin(String(Math.round(cfg.session_seconds / 60)));
    setCooldownSec(String(cfg.cooldown_seconds));
    setThrottleSec(String(cfg.throttle_seconds));
    setAutoBan(String(cfg.auto_ban_threshold ?? 0));
    setKillSwitch(cfg.kill_switch ?? false);
    setSg(String(cfg.stickiness_green ?? 20));
    setSy(String(cfg.stickiness_yellow ?? 10));
    setR1g(String(cfg.retention_d1_green ?? 40));
    setR1y(String(cfg.retention_d1_yellow ?? 20));
    setR7g(String(cfg.retention_d7_green ?? 20));
    setR7y(String(cfg.retention_d7_yellow ?? 10));
    setWauDrop(String(cfg.wau_drop_alert_pct ?? 20));
    setDauDrop(String(cfg.dau_drop_alert_pct ?? 30));
    setRetDrop(String(cfg.retention_drop_alert_pct ?? 25));
  }, [cfg]);

  async function saveBenchmarks() {
    try {
      setBenchBusy(true);
      await saveSettings({
        data: {
          sessionMinutes: sessionMin,
          cooldownSeconds: cooldownSec,
          throttleSeconds: throttleSec,
          autoBanThreshold: autoBan,
          killSwitch,
          stickinessGreen: sg,
          stickinessYellow: sy,
          retentionD1Green: r1g,
          retentionD1Yellow: r1y,
          retentionD7Green: r7g,
          retentionD7Yellow: r7y,
          wauDropAlertPct: wauDrop,
          dauDropAlertPct: dauDrop,
          retentionDropAlertPct: retDrop,
        },
      });
      setBenchSaved(true);
      setTimeout(() => setBenchSaved(false), 2000);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBenchBusy(false);
    }
  }

  async function save() {
    try {
      setBusy(true);
      await saveSettings({
        data: {
          sessionMinutes: sessionMin,
          cooldownSeconds: cooldownSec,
          throttleSeconds: throttleSec,
          autoBanThreshold: autoBan,
          killSwitch,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed";
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleKill(next: boolean) {
    setKillSwitch(next);
    try {
      setBusy(true);
      await saveSettings({
        data: {
          sessionMinutes: sessionMin,
          cooldownSeconds: cooldownSec,
          throttleSeconds: throttleSec,
          autoBanThreshold: autoBan,
          killSwitch: next,
        },
      });
      reload();
    } catch (error) {
      setKillSwitch(!next);
      const message = error instanceof Error ? error.message : "Save failed";
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-6">
      <div className={`rounded-xl border p-6 ${killSwitch ? "border-destructive/50 bg-destructive/10" : "border-border bg-card"}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle className={`h-5 w-5 ${killSwitch ? "text-destructive" : "text-amber-400"}`} />
              <h2 className="text-lg font-semibold">Kill switch</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {killSwitch
                ? "Service is DISABLED. Every HWID check returns 'disabled' until you turn this off."
                : "Instantly disable all script execution across every game. Useful for emergencies or pushing updates."}
            </p>
          </div>
          <button
            onClick={() => toggleKill(!killSwitch)}
            className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium ${killSwitch ? "bg-destructive text-destructive-foreground" : "border border-border bg-background/60 hover:border-destructive/50"}`}
          >
            {killSwitch ? "Re-enable service" : "Kill service"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Session configuration</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Live settings stored in the database — changes apply on the next RPC call. No SQL or redeploy needed.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <NumField
            label="Session length"
            unit="minutes"
            hint={`Allowed: ${APP_SETTINGS_LIMITS.sessionMinutes.min}-${APP_SETTINGS_LIMITS.sessionMinutes.max} min`}
            value={sessionMin}
            min={APP_SETTINGS_LIMITS.sessionMinutes.min}
            max={APP_SETTINGS_LIMITS.sessionMinutes.max}
            onChange={setSessionMin}
          />
          <NumField
            label="Cooldown length"
            unit="seconds"
            hint={`Allowed: ${APP_SETTINGS_LIMITS.cooldownSeconds.min}-${APP_SETTINGS_LIMITS.cooldownSeconds.max} sec`}
            value={cooldownSec}
            min={APP_SETTINGS_LIMITS.cooldownSeconds.min}
            max={APP_SETTINGS_LIMITS.cooldownSeconds.max}
            onChange={setCooldownSec}
          />
          <NumField
            label="Throttle per HWID"
            unit="seconds"
            hint={`Allowed: ${APP_SETTINGS_LIMITS.throttleSeconds.min}-${APP_SETTINGS_LIMITS.throttleSeconds.max} sec`}
            value={throttleSec}
            min={APP_SETTINGS_LIMITS.throttleSeconds.min}
            max={APP_SETTINGS_LIMITS.throttleSeconds.max}
            onChange={setThrottleSec}
          />
          <NumField
            label="Auto-ban after"
            unit="hits"
            hint={`Allowed: ${APP_SETTINGS_LIMITS.autoBanThreshold.min}-${APP_SETTINGS_LIMITS.autoBanThreshold.max} hits`}
            value={autoBan}
            min={APP_SETTINGS_LIMITS.autoBanThreshold.min}
            max={APP_SETTINGS_LIMITS.autoBanThreshold.max}
            onChange={setAutoBan}
          />
        </div>
        <div className="mt-5 flex items-center gap-3">
          <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy ? "Saving…" : "Save settings"}
          </button>
          {saved && <span className="text-sm text-primary">Saved.</span>}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground space-y-2">
        <p><strong className="text-foreground">Session length</strong> is stored in <strong className="text-foreground">minutes only</strong>. Typing <code>10</code> means <code>10 minutes</code>, never <code>10 hours</code>.</p>
        <p><strong className="text-foreground">Cooldown length</strong> can now be set as low as <code>10</code> seconds for testing, or <code>0</code> to skip cooldown entirely.</p>
        <p><strong className="text-foreground">Throttle</strong> blocks abusive rapid-fire <code>check_hwid</code> spam, but it does not end a valid active session anymore. Set it to <code>0</code> to disable.</p>
        <p><strong className="text-foreground">Auto-ban</strong> permanently bans a HWID after it hits the throttle this many times in a row. Set to <code>0</code> to disable.</p>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Health benchmarks &amp; alerts</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          These thresholds color the metric cards on the Analytics tab green / yellow / red,
          and they decide when the daily server-side check fires an alert. Values are percentages (0–100).
        </p>
        <div className="mt-3 rounded-md border border-border bg-background/40 p-3 text-xs text-muted-foreground space-y-1">
          <p><strong className="text-foreground">Green = healthy</strong>: metric is at or above this number.</p>
          <p><strong className="text-foreground">Yellow = watch</strong>: metric is between yellow and green.</p>
          <p><strong className="text-foreground">Red = unhealthy</strong>: metric is below yellow.</p>
          <p><strong className="text-foreground">Drop alerts</strong> trigger when a metric falls by at least this % compared to the previous period (WAU: 7d vs prior 7d; DAU: today vs trailing 7d avg; retention: this week's D+1 cohort vs prior week's).</p>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <NumField label="Stickiness green" unit="%" hint="DAU÷MAU at or above is healthy (default 20)" value={sg}  min={0} max={100} onChange={setSg} />
          <NumField label="Stickiness yellow" unit="%" hint="Below green but ≥ this is 'watch' (default 10)" value={sy}  min={0} max={100} onChange={setSy} />
          <div />
          <NumField label="D+1 retention green"  unit="%" hint="Healthy at/above (default 40)" value={r1g} min={0} max={100} onChange={setR1g} />
          <NumField label="D+1 retention yellow" unit="%" hint="'Watch' floor (default 20)"    value={r1y} min={0} max={100} onChange={setR1y} />
          <div />
          <NumField label="D+7 retention green"  unit="%" hint="Healthy at/above (default 20)" value={r7g} min={0} max={100} onChange={setR7g} />
          <NumField label="D+7 retention yellow" unit="%" hint="'Watch' floor (default 10)"    value={r7y} min={0} max={100} onChange={setR7y} />
          <div />
          <NumField label="WAU drop alert"        unit="%" hint="Alert if WAU falls by ≥ this WoW (default 20)"   value={wauDrop} min={1} max={90} onChange={setWauDrop} />
          <NumField label="DAU drop alert"        unit="%" hint="Alert if today's DAU is ≥ this below 7d avg (default 30)" value={dauDrop} min={1} max={90} onChange={setDauDrop} />
          <NumField label="Retention drop alert"  unit="%" hint="Alert if D+1 retention falls ≥ this WoW (default 25)" value={retDrop} min={1} max={90} onChange={setRetDrop} />
        </div>
        <div className="mt-5 flex items-center gap-3">
          <button onClick={saveBenchmarks} disabled={benchBusy} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {benchBusy ? "Saving…" : "Save benchmarks"}
          </button>
          {benchSaved && <span className="text-sm text-primary">Saved.</span>}
        </div>
      </div>
    </div>
  );
}

function NumField({ label, unit, hint, value, min, max, onChange }: { label: string; unit: string; hint: string; value: string; min: number; max: number; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between gap-3 text-xs uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono normal-case tracking-normal">{unit}</span>
      </div>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm font-mono"
      />
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </label>
  );
}

function CredField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background/60 p-3">
        <code className={`flex-1 truncate text-xs ${mono ? "font-mono" : ""}`}>{value}</code>
        <button
          onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs hover:border-primary/50"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs hover:border-primary/50"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-border bg-background/60 p-4 text-xs leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

function ApiDocs() {
  const scriptsMapEndpoint = SCRIPTS_ENDPOINT;

  const lua = `-- Roblox Lua: full loader with per-game script URLs
local HttpService = game:GetService("HttpService")

local _request = request or (syn and syn.request) or http_request

  local API_BASE_URL = "${APP_ORIGIN}"
  local CHECK_ENDPOINT = "${CHECK_ENDPOINT}"
  local SCRIPT_MAP_ENDPOINT = "${scriptsMapEndpoint}"
local SCRIPT_ENDPOINT = "${SCRIPT_ENDPOINT}"

local function getHWID()
    local ok, id = pcall(function()
        return game:GetService("RbxAnalyticsService"):GetClientId()
    end)
    if ok and id and id ~= "" then
        return tostring(id)
    end
    return tostring(game:GetService("Players").LocalPlayer.UserId)
end

local function requestJson(options)
    if not _request then
        return nil, "no request function available"
    end
    local ok, res = pcall(function()
        return _request(options)
    end)
    if not ok then
        return nil, "request failed: " .. tostring(res)
    end
    local statusCode = tonumber(res.StatusCode) or 0
    if statusCode < 200 or statusCode >= 300 then
        return nil, "http " .. tostring(res.StatusCode) .. ": " .. tostring(res.Body)
    end
    local decodedOk, data = pcall(function()
        return HttpService:JSONDecode(res.Body)
    end)
    if not decodedOk then
        return nil, "bad json: " .. tostring(data)
    end
    return data, nil
end

local function checkSession(hwid)
    return requestJson({
Url = CHECK_ENDPOINT,
  Method = "POST",
  Headers = {
  ["Content-Type"] = "application/json",
        },
Body = HttpService:JSONEncode({ hwid = hwid, game_id = tostring(game.PlaceId) })
    })
end

local function getScriptUrl(token)
    local data, err = requestJson({
        Url = SCRIPT_MAP_ENDPOINT,
        Method = "GET",
        Headers = {
            ["X-Session-Token"] = tostring(token),
        },
    })

    if not data then
        warn("[Script] Script map failed, using fallback: " .. tostring(err))
        return SCRIPT_ENDPOINT
    end

    local placeId = tostring(game.PlaceId)
    if type(data[placeId]) == "string" and data[placeId] ~= "" then
        return data[placeId]
    end
    if type(data.default) == "string" and data.default ~= "" then
        return data.default
    end
    return SCRIPT_ENDPOINT
end

local function fetchText(url, token)
    if not _request then
        return nil, "no request function available"
    end
    local ok, res = pcall(function()
        return _request({
            Url = url,
            Method = "GET",
            Headers = { ["X-Session-Token"] = tostring(token) },
        })
    end)
    if not ok then
        return nil, tostring(res)
    end
    local statusCode = tonumber(res.StatusCode) or 0
    if statusCode < 200 or statusCode >= 300 then
        return nil, "http " .. tostring(res.StatusCode) .. ": " .. tostring(res.Body)
    end
    return tostring(res.Body or ""), nil
end

local result, authErr = checkSession(getHWID())
if not result then
    warn("[Script] Auth request failed: " .. tostring(authErr))
    return
end
-- result.status  -> "allowed" | "session_active" | "cooldown" | "banned" | "game_not_allowed" | "throttled" | "error"
-- result.remaining -> seconds left (number)

if result.status == "allowed" or result.status == "session_active" then
    print("[Script] Active. " .. tostring(result.remaining or "?") .. "s remaining.")
    if not result.session_token then
        warn("[Script] Missing session token from auth response.")
        return
    end

    local scriptUrl = getScriptUrl(result.session_token)
    print("[Script] Loading from: " .. tostring(scriptUrl))

    local body, fetchErr = fetchText(scriptUrl, result.session_token)
    if not body then
        warn("[Script] Script fetch failed: " .. tostring(fetchErr))
        return
    end

    local chunk, compileErr = loadstring(body)
    if not chunk then
        warn("[Script] Downloaded script compile error: " .. tostring(compileErr))
        return
    end
    local runOk, runErr = pcall(chunk)
    if not runOk then
        warn("[Script] Downloaded script runtime error: " .. tostring(runErr))
        return
    end
elseif result.status == "cooldown" then
    warn("[Script] On cooldown. Try again in " .. tostring(result.remaining or "?") .. "s.")
    return
elseif result.status == "game_not_allowed" then
    warn("[Script] This game is not enabled.")
    return
else
    warn("[Script] Error: " .. tostring(result.message))
    return
end`;

  const curl = `curl -X POST "${CHECK_ENDPOINT}" \\
  -H "Content-Type: application/json" \\
  -d '{"hwid":"YOUR_HWID_HERE","game_id":"YOUR_PLACE_ID"}'`;

  const loader = `-- Minimal safe loader for your script
local h = game:GetService("HttpService")
  local CHECK_URL = "${CHECK_ENDPOINT}"
local reqImpl = request or (syn and syn.request) or http_request
local function req(o)
    local ok,r=pcall(function() return reqImpl(o) end)
    if ok and r and tonumber(r.StatusCode) and tonumber(r.StatusCode) >= 200 and tonumber(r.StatusCode) < 300 then return r end
    warn("Request failed: "..tostring(ok and r and r.Body or r))
end
local auth = req({ Url = "${CHECK_ENDPOINT}", Method = "POST", Headers = { ["Content-Type"]="application/json" }, Body = h:JSONEncode({ hwid = game:GetService("RbxAnalyticsService"):GetClientId(), game_id = tostring(game.PlaceId) }) })
if not auth then return end
local ok,r = pcall(function() return h:JSONDecode(auth.Body) end)
if not ok then warn("Bad auth response") return end
if r.status == "allowed" or r.status == "session_active" then
    if not r.session_token then warn("Missing session token") return end
    local mapRes = req({ Url = "${scriptsMapEndpoint}", Method = "GET", Headers = { ["X-Session-Token"] = tostring(r.session_token) } })
    local target = "${SCRIPT_ENDPOINT}"
    if mapRes then
        local okMap, map = pcall(function() return h:JSONDecode(mapRes.Body) end)
        if okMap and type(map) == "table" then
            target = map[tostring(game.PlaceId)] or map.default or target
        end
    end
    local s = req({ Url = target, Method = "GET", Headers = { ["X-Session-Token"] = tostring(r.session_token) } })
    if not s then return end
    local chunk, err = loadstring(s.Body)
    if not chunk then warn("Compile error: "..tostring(err)) return end
    local ran, runErr = pcall(chunk)
    if not ran then warn("Runtime error: "..tostring(runErr)) end
elseif r.status == "game_not_allowed" then
    warn("Game not enabled")
else
    warn(tostring(r.status) .. ": " .. tostring(r.remaining or r.message))
end`;

  return (
    <div className="mt-8 space-y-8">
      <section>
        <h2 className="text-xl font-semibold">Overview</h2>
        <p className="mt-2 text-sm text-muted-foreground">
The API runs on the same Vercel deployment as this dashboard. POST a HWID to the Vercel route; Redis enforces active timers and cooldowns, while Supabase stores durable session records.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Endpoint</h2>
        <div className="mt-3 rounded-lg border border-border bg-card p-4 text-sm">
          <div><span className="font-mono text-primary">POST</span> <span className="font-mono break-all">{CHECK_ENDPOINT}</span></div>
          <div className="mt-3 text-xs text-muted-foreground">Headers</div>
          <ul className="mt-1 list-disc pl-5 text-xs font-mono text-muted-foreground">
            <li>Content-Type: application/json</li>
<li>No API key required</li>
  <li>Access is granted by the short-lived session token returned by this route</li>
          </ul>
          <div className="mt-3 text-xs text-muted-foreground">Body</div>
          <pre className="mt-1 text-xs font-mono">{`{ "hwid": "string (3-256 chars)", "game_id": "place id (optional)" }`}</pre>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Response</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-4 py-2">status</th><th className="px-4 py-2">meaning</th><th className="px-4 py-2">remaining</th></tr>
            </thead>
            <tbody className="text-xs">
              <tr className="border-t border-border"><td className="px-4 py-2 font-mono text-primary">allowed</td><td className="px-4 py-2">New session created — run the script.</td><td className="px-4 py-2 font-mono">1800</td></tr>
              <tr className="border-t border-border"><td className="px-4 py-2 font-mono text-primary">session_active</td><td className="px-4 py-2">Session in progress — script may run.</td><td className="px-4 py-2 font-mono">≤ 1800</td></tr>
              <tr className="border-t border-border"><td className="px-4 py-2 font-mono text-accent">cooldown</td><td className="px-4 py-2">Blocked, wait it out.</td><td className="px-4 py-2 font-mono">≤ 18000</td></tr>
              <tr className="border-t border-border"><td className="px-4 py-2 font-mono text-destructive">banned</td><td className="px-4 py-2">HWID has been banned.</td><td className="px-4 py-2 font-mono">—</td></tr>
              <tr className="border-t border-border"><td className="px-4 py-2 font-mono text-destructive">game_not_allowed</td><td className="px-4 py-2">Game id missing or not on the allow list.</td><td className="px-4 py-2 font-mono">—</td></tr>
              <tr className="border-t border-border"><td className="px-4 py-2 font-mono text-accent">throttled</td><td className="px-4 py-2">Too many requests too fast.</td><td className="px-4 py-2 font-mono">≤ throttle</td></tr>
              <tr className="border-t border-border"><td className="px-4 py-2 font-mono text-destructive">disabled</td><td className="px-4 py-2">Kill switch is active — service paused.</td><td className="px-4 py-2 font-mono">—</td></tr>
              <tr className="border-t border-border"><td className="px-4 py-2 font-mono text-destructive">error</td><td className="px-4 py-2">Invalid HWID payload.</td><td className="px-4 py-2 font-mono">—</td></tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          On <code className="text-primary">allowed</code> / <code className="text-primary">session_active</code> the response also includes <code className="text-primary">session_token</code> — a one-time UUID (5-min TTL) used to fetch the protected script.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Script Delivery</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The actual Lua payload is served from a server route that validates the <code className="text-primary">session_token</code> against the database before responding. Faked client-side auth responses can't reach this endpoint — only tokens minted by <code className="text-primary">check_hwid</code> are accepted, and each token dies after a single use.
        </p>
        <div className="mt-3 rounded-lg border border-border bg-card p-4 text-sm">
          <div><span className="font-mono text-primary">GET</span> <span className="font-mono break-all">{SCRIPT_ENDPOINT}</span></div>
          <div className="mt-3 text-xs text-muted-foreground">Headers</div>
          <ul className="mt-1 list-disc pl-5 text-xs font-mono text-muted-foreground">
            <li>X-Session-Token: &lt;session_token from check_hwid&gt;</li>
          </ul>
          <div className="mt-3 text-xs text-muted-foreground">Responses</div>
          <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
            <li><span className="font-mono text-primary">200</span> — Lua script body (<code>text/plain</code>)</li>
            <li><span className="font-mono text-destructive">401</span> — missing, expired, already-used, or invalid token</li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Edit the script body in <code className="text-primary">src/lib/protected-script.ts</code> (the <code>SCRIPT_CONTENT</code> constant).
          </p>
        </div>
          <div className="mt-3 rounded-lg border border-border bg-card p-4 text-sm">
            <div><span className="font-mono text-primary">GET</span> <span className="font-mono break-all">{scriptsMapEndpoint}</span></div>
            <div className="mt-3 text-xs text-muted-foreground">Headers</div>
            <ul className="mt-1 list-disc pl-5 text-xs font-mono text-muted-foreground">
              <li>X-Session-Token: &lt;session_token from check_hwid&gt;</li>
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Returns a JSON map of <code>placeId -&gt; script url</code> plus <code>default</code>. This lookup no longer consumes the one-time token, so your loader can call it first and then fetch the actual script.
            </p>
          </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Roblox Lua — full example</h2>
        <div className="mt-3"><CodeBlock code={lua} /></div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Roblox Lua — minimal loader</h2>
        <p className="mt-1 text-sm text-muted-foreground">Drop-in version that loads your script when allowed.</p>
        <div className="mt-3"><CodeBlock code={loader} /></div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">cURL test</h2>
        <div className="mt-3"><CodeBlock code={curl} /></div>
      </section>
    </div>
  );
}

function Stat({ label, value, icon, accent }: { label: string; value: number; icon: React.ReactNode; accent: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={accent}>{icon}</span>
      </div>
      <div className="mt-3 text-3xl font-bold">{value}</div>
    </div>
  );
}

function PublicApiTab() {
  const [gameId, setGameId] = useState("11653088948");
  const [baseUrl, setBaseUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<number | null>(null);
  const [testMs, setTestMs] = useState<number | null>(null);
  const [testBody, setTestBody] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") setBaseUrl(window.location.origin);
  }, []);

  async function runTest() {
    const id = gameId.trim();
    if (!/^\d{1,32}$/.test(id)) { toast.error("Enter a numeric game ID"); return; }
    setTesting(true); setTestStatus(null); setTestMs(null); setTestBody("");
    const started = performance.now();
    try {
      const res = await fetch(`${baseUrl}/api/public/roblox?gameId=${encodeURIComponent(id)}`);
      setTestStatus(res.status);
      const text = await res.text();
      try { setTestBody(JSON.stringify(JSON.parse(text), null, 2)); } catch { setTestBody(text); }
    } catch (e) {
      setTestBody(e instanceof Error ? e.message : String(e));
    } finally {
      setTestMs(Math.round(performance.now() - started));
      setTesting(false);
    }
  }

  const endpointUrl = `${baseUrl}/api/public/roblox`;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">Public endpoint</div>
            <p className="text-xs text-muted-foreground mt-1">
              Pure game ID lookup for the Vercel API. Enter a game ID, hit test, and inspect the raw response.
            </p>
          </div>
          <span className="text-[11px] font-mono px-2 py-1 rounded-md bg-primary/15 text-primary">lookup only</span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 rounded-md bg-muted/40 px-3 py-2 text-xs font-mono break-all">{endpointUrl}?gameId=…</code>
          <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(endpointUrl); toast.success("Copied"); }}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="text-sm font-semibold">Lookup test</div>
        <div className="flex items-center gap-2">
          <Input value={gameId} onChange={(e) => setGameId(e.target.value)} placeholder="Game ID to look up" className="font-mono max-w-xs" />
          <Button onClick={runTest} disabled={testing}>
            {testing ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            Send
          </Button>
          {testStatus !== null && (
            <span className={`text-xs font-mono px-2 py-1 rounded-md ${testStatus >= 200 && testStatus < 300 ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{testStatus}</span>
          )}
          {testMs !== null && <span className="text-xs text-muted-foreground">{testMs}ms</span>}
        </div>
        {testBody && (
          <pre className="max-h-[240px] overflow-auto rounded-md bg-muted/30 p-3 text-[11px] font-mono whitespace-pre-wrap break-all">{testBody}</pre>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-sm font-semibold mb-2">Lua / Roblox executor snippet</div>
        <pre className="overflow-auto rounded-md bg-muted/30 p-3 text-[11px] font-mono">{`local HttpService = game:GetService("HttpService")
local gameId = tostring(game.PlaceId)
local apiUrl = "${baseUrl}/api/public/roblox?gameId=" .. gameId

local ok, response = pcall(function() return game:HttpGet(apiUrl, true) end)
if ok and response then
  local data = HttpService:JSONDecode(response)
  local url = data[gameId]
  if type(url) == "table" then url = url[1] end
  if url then
    loadstring(game:HttpGet(url, true))()
  end
end`}</pre>
      </div>
    </div>
  );
}

type AnalyticsRow = {
  day: string;
  total_checks: number;
  sessions_started: number;
  sessions_expired: number;
  cooldowns_cleared: number;
  unique_hwids: number;
  active_at_snapshot: number;
  cooldown_at_snapshot: number;
  updated_at: string;
};

type HourlyRow = { day: string; hour: number; total_checks: number; sessions_started: number };
type HwidSeenRow = { day: string; hwid: string; last_game_id: string | null; check_count: number; sessions_started: number };
type GameNameRow = { game_id: string; name: string | null };
type AlertRow = {
  id: string;
  kind: string;
  severity: string;
  message: string;
  details: Record<string, unknown> | null;
  created_at: string;
  acknowledged_at: string | null;
};
type DrilldownState = null | {
  title: string;
  subtitle: string;
  explanation: string;
  rows: { hwid: string; checks: number; days: number; lastGame: string }[];
  meta?: { label: string; value: string }[];
};

type HwidDrillState = null | {
  hwid: string;
  lastGame: string;
  totalChecks: number;
  daysActive: number;
  loading: boolean;
  daily: { day: string; checks: number; sessions: number; lastGame: string; lastSeen: string }[];
  sessions: { created_at: string; script_url: string | null }[];
  peakPerMin: number;
  peakAt: string | null;
};

function AnalyticsTab({ cfg }: { cfg: Settings }) {
  const [rows, setRows] = useState<AnalyticsRow[]>([]);
  const [hourly, setHourly] = useState<HourlyRow[]>([]);
  const [seen, setSeen] = useState<HwidSeenRow[]>([]);
  const [gameNames, setGameNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [drill, setDrill] = useState<DrilldownState>(null);
  const [hwidDrill, setHwidDrill] = useState<HwidDrillState>(null);
  const [velocityMap, setVelocityMap] = useState<Record<string, { peak: number; at: string | null }>>({});
  const [runningChecks, setRunningChecks] = useState(false);
  const runAlerts = useServerFn(runGrowthAlerts);
  async function load() {
    setLoading(true);
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const back14 = new Date(today.getTime() - 30 * 86400_000).toISOString().slice(0, 10);

    const [daily, hr, sn, al] = await Promise.all([
      supabase.from("analytics_daily" as any).select("*").order("day", { ascending: false }).limit(30),
      supabase.from("analytics_hourly" as any).select("*").eq("day", todayStr).order("hour", { ascending: true }),
      supabase.from("hwid_daily_seen" as any).select("day,hwid,last_game_id,check_count,sessions_started").gte("day", back14),
      supabase.from("analytics_alerts" as any).select("*").is("acknowledged_at", null).order("created_at", { ascending: false }).limit(20),
    ]);
    setRows((daily.data ?? []) as unknown as AnalyticsRow[]);
    setHourly((hr.data ?? []) as unknown as HourlyRow[]);
    const seenRows = (sn.data ?? []) as unknown as HwidSeenRow[];
    setSeen(seenRows);
    setAlerts(((al?.data ?? []) as unknown as AlertRow[]));

    const ids = Array.from(new Set(seenRows.map((r) => r.last_game_id).filter((x): x is string => !!x)));
    if (ids.length) {
      const { data: gc } = await supabase.from("game_cache" as any).select("game_id,game_name").in("game_id", ids);
      const map: Record<string, string> = {};
      ((gc ?? []) as any[]).forEach((g) => { map[g.game_id] = g.game_name; });
      setGameNames(map);
    } else {
      setGameNames({});
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("admin-analytics")
      .on("postgres_changes", { event: "*", schema: "public", table: "analytics_daily" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "analytics_alerts" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // Fetch per-minute session timestamps for top HWIDs → compute peak checks/min (velocity).
  useEffect(() => {
    if (seen.length === 0) { setVelocityMap({}); return; }
    // Re-derive top HWIDs (mirrors topHwids logic) to know which to query.
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const tally = new Map<string, number>();
    for (const r of seen) if (r.day >= cutoff) tally.set(r.hwid, (tally.get(r.hwid) ?? 0) + r.check_count);
    const topList = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([h]) => h);
    if (topList.length === 0) { setVelocityMap({}); return; }
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("sessions" as any)
        .select("hwid,created_at")
        .in("hwid", topList)
        .gte("created_at", since)
        .limit(20000);
      if (cancelled) return;
      const buckets = new Map<string, Map<number, number>>(); // hwid -> minute-bucket -> count
      for (const r of ((data ?? []) as unknown) as { hwid: string; created_at: string }[]) {
        const m = Math.floor(new Date(r.created_at).getTime() / 60000);
        const inner = buckets.get(r.hwid) ?? new Map<number, number>();
        inner.set(m, (inner.get(m) ?? 0) + 1);
        buckets.set(r.hwid, inner);
      }
      const result: Record<string, { peak: number; at: string | null }> = {};
      buckets.forEach((inner, hwid) => {
        let peak = 0; let peakMin: number | null = null;
        inner.forEach((c, m) => { if (c > peak) { peak = c; peakMin = m; } });
        result[hwid] = { peak, at: peakMin !== null ? new Date(peakMin * 60000).toISOString() : null };
      });
      setVelocityMap(result);
    })();
    return () => { cancelled = true; };
  }, [seen]);

  async function openHwidDrill(h: { hwid: string; gameName: string; checks: number; days: number }) {
    setHwidDrill({
      hwid: h.hwid, lastGame: h.gameName, totalChecks: h.checks, daysActive: h.days,
      loading: true, daily: [], sessions: [], peakPerMin: 0, peakAt: null,
    });
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
    const [dailyRes, sessRes] = await Promise.all([
      supabase.from("hwid_daily_seen" as any).select("day,check_count,sessions_started,last_game_id,last_seen_at").eq("hwid", h.hwid).gte("day", since30).order("day", { ascending: false }),
      supabase.from("sessions" as any).select("created_at,script_url").eq("hwid", h.hwid).gte("created_at", since7).order("created_at", { ascending: false }).limit(500),
    ]);
    const dailyRows = ((dailyRes.data ?? []) as any[]).map((r) => ({
      day: r.day,
      checks: r.check_count,
      sessions: r.sessions_started,
      lastGame: r.last_game_id ? (gameNames[r.last_game_id] || `Game ${r.last_game_id}`) : "—",
      lastSeen: r.last_seen_at,
    }));
    const sessionRows = ((sessRes.data ?? []) as any[]).map((r) => ({ created_at: r.created_at, script_url: r.script_url }));
    // Peak per minute over 7d sessions
    const buckets = new Map<number, number>();
    for (const s of sessionRows) {
      const m = Math.floor(new Date(s.created_at).getTime() / 60000);
      buckets.set(m, (buckets.get(m) ?? 0) + 1);
    }
    let peak = 0; let peakMin: number | null = null;
    buckets.forEach((c, m) => { if (c > peak) { peak = c; peakMin = m; } });
    setHwidDrill({
      hwid: h.hwid, lastGame: h.gameName, totalChecks: h.checks, daysActive: h.days,
      loading: false, daily: dailyRows, sessions: sessionRows,
      peakPerMin: peak, peakAt: peakMin !== null ? new Date(peakMin * 60000).toISOString() : null,
    });
  }

  async function acknowledgeAlert(id: string) {
    const { error } = await supabase.rpc("acknowledge_alert" as any, { _id: id });
    if (error) { toast.error(error.message); return; }
    toast.success("Alert acknowledged");
    load();
  }

  async function runChecksNow() {
    setRunningChecks(true);
    try {
      const res = await runAlerts({});
      const parsed = JSON.parse(res.result || "{}");
      const n = parsed.inserted ?? 0;
      if (n > 0) toast.success(`Triggered ${n} new alert${n === 1 ? "" : "s"}`);
      else toast.success("Checks ran — nothing flagged. All metrics within thresholds.");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to run checks");
    } finally {
      setRunningChecks(false);
    }
  }

  const today = rows[0];
  const last7 = rows.slice(0, 7);
  const prev7 = rows.slice(7, 14);
  const sum = (k: keyof AnalyticsRow) => last7.reduce((acc, r) => acc + (Number(r[k]) || 0), 0);
  const sumRange = (range: AnalyticsRow[], k: keyof AnalyticsRow) =>
    range.reduce((acc, r) => acc + (Number(r[k]) || 0), 0);

  // Hourly chart: fill all 24 hours
  const hourlyData = Array.from({ length: 24 }, (_, h) => {
    const row = hourly.find((r) => r.hour === h);
    return { hour: `${h.toString().padStart(2, "0")}h`, checks: row?.total_checks ?? 0, sessions: row?.sessions_started ?? 0 };
  });

  // Per-game: group seen by last_game_id (last 7d)
  const last7Cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const seen7 = seen.filter((r) => r.day >= last7Cutoff);
  const perGameMap = new Map<string, { checks: number; sessions: number; hwids: Set<string> }>();
  for (const r of seen7) {
    const k = r.last_game_id || "(unknown)";
    const e = perGameMap.get(k) ?? { checks: 0, sessions: 0, hwids: new Set() };
    e.checks += r.check_count;
    e.sessions += r.sessions_started;
    e.hwids.add(r.hwid);
    perGameMap.set(k, e);
  }
  const perGame = Array.from(perGameMap.entries())
    .map(([gid, v]) => ({ gameId: gid, name: gameNames[gid] || (gid === "(unknown)" ? "Unknown" : `Game ${gid}`), checks: v.checks, sessions: v.sessions, hwids: v.hwids.size }))
    .sort((a, b) => b.checks - a.checks)
    .slice(0, 10);

  // Retention D+1: for each day d in window, |hwid(d) ∩ hwid(d+1)| / |hwid(d)|
  const byDay = new Map<string, Set<string>>();
  for (const r of seen) {
    const s = byDay.get(r.day) ?? new Set();
    s.add(r.hwid);
    byDay.set(r.day, s);
  }
  const sortedDays = Array.from(byDay.keys()).sort();
  const retention = sortedDays.slice(0, -1).map((d) => {
    const dt = new Date(d);
    const next = new Date(dt.getTime() + 86400_000).toISOString().slice(0, 10);
    const a = byDay.get(d) ?? new Set();
    const b = byDay.get(next) ?? new Set();
    let overlap = 0;
    a.forEach((h) => { if (b.has(h)) overlap += 1; });
    return { day: d.slice(5), cohort: a.size, returned: overlap, pct: a.size ? Math.round((overlap / a.size) * 100) : 0 };
  });

  // Top HWIDs last 7d
  const topHwidMap = new Map<string, { checks: number; days: Set<string>; lastGame: string | null; lastDay: string | null }>();
  for (const r of seen7) {
    const e = topHwidMap.get(r.hwid) ?? { checks: 0, days: new Set(), lastGame: null, lastDay: null };
    e.checks += r.check_count;
    e.days.add(r.day);
    if (r.last_game_id) e.lastGame = r.last_game_id;
    if (!e.lastDay || r.day > e.lastDay) e.lastDay = r.day;
    topHwidMap.set(r.hwid, e);
  }
  const topHwids = Array.from(topHwidMap.entries())
    .map(([hwid, v]) => {
      const days = v.days.size;
      const avg = days > 0 ? v.checks / days : v.checks;
      // Risk heuristic: very heavy use (likely bot/abuse)
      // - 500+ checks across the window, OR
      // - active every day with 100+/day average
      const risk: "high" | "medium" | "low" =
        v.checks >= 500 || (days >= 6 && avg >= 100)
          ? "high"
          : v.checks >= 150 || (days >= 4 && avg >= 40)
            ? "medium"
            : "low";
      return {
        hwid,
        checks: v.checks,
        days,
        avgPerActiveDay: Math.round(avg),
        gameName: v.lastGame ? (gameNames[v.lastGame] || `Game ${v.lastGame}`) : "—",
        lastDay: v.lastDay,
        risk,
      };
    })
    .sort((a, b) => b.checks - a.checks)
    .slice(0, 15);

  // 7d vs prev 7d delta
  const cmpMetrics = [
    { key: "total_checks" as const, label: "Checks" },
    { key: "sessions_started" as const, label: "Sessions started" },
    { key: "unique_hwids" as const, label: "Unique HWIDs (snapshot)" },
    { key: "cooldowns_cleared" as const, label: "Cooldowns cleared" },
  ];
  const compareCards = cmpMetrics.map((m) => {
    const cur = sumRange(last7, m.key);
    const prev = sumRange(prev7, m.key);
    const delta = cur - prev;
    const pct = prev === 0 ? (cur > 0 ? 100 : 0) : Math.round((delta / prev) * 100);
    return { ...m, cur, prev, delta, pct };
  });

  // ===== Growth & Engagement (DAU/WAU/MAU, stickiness, new vs returning, retention curve) =====
  const todayStr = new Date().toISOString().slice(0, 10);
  const dayMs = 86400_000;
  const dateNDaysAgo = (n: number) => new Date(Date.now() - n * dayMs).toISOString().slice(0, 10);

  // First-seen day per HWID across the full 30d window we loaded
  const firstSeen = new Map<string, string>();
  for (const r of seen) {
    const prev = firstSeen.get(r.hwid);
    if (!prev || r.day < prev) firstSeen.set(r.hwid, r.day);
  }

  const hwidsInRange = (fromDay: string, toDay: string) => {
    const s = new Set<string>();
    for (const r of seen) if (r.day >= fromDay && r.day <= toDay) s.add(r.hwid);
    return s;
  };

  const dau = hwidsInRange(todayStr, todayStr).size;
  const wau = hwidsInRange(dateNDaysAgo(6), todayStr).size;
  const mau = hwidsInRange(dateNDaysAgo(29), todayStr).size;
  const stickiness = mau ? Math.round((dau / mau) * 100) : 0;

  // WoW growth on WAU
  const wauPrev = hwidsInRange(dateNDaysAgo(13), dateNDaysAgo(7)).size;
  const wauDelta = wau - wauPrev;
  const wauPct = wauPrev === 0 ? (wau > 0 ? 100 : 0) : Math.round((wauDelta / wauPrev) * 100);

  // New vs returning today (new = first_seen == today)
  const todayHwids = hwidsInRange(todayStr, todayStr);
  let newToday = 0;
  todayHwids.forEach((h) => { if (firstSeen.get(h) === todayStr) newToday += 1; });
  const returningToday = todayHwids.size - newToday;

  // New users per day (last 14d) — growth signal
  const newPerDay: { day: string; new_hwids: number; total_hwids: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = dateNDaysAgo(i);
    const dayHwids = hwidsInRange(d, d);
    let n = 0;
    dayHwids.forEach((h) => { if (firstSeen.get(h) === d) n += 1; });
    newPerDay.push({ day: d.slice(5), new_hwids: n, total_hwids: dayHwids.size });
  }

  // Retention curve: of HWIDs first seen on cohort day, % returning by D+1, D+7, D+14
  // Use cohorts from 14+ days ago so D+14 is observable
  const cohortDays = sortedDays.filter((d) => {
    const ageDays = Math.floor((Date.now() - new Date(d).getTime()) / dayMs);
    return ageDays >= 14 && ageDays <= 29;
  });
  const retentionCurve = (() => {
    if (cohortDays.length === 0) return null;
    let cohortSize = 0;
    let r1 = 0, r7 = 0, r14 = 0;
    for (const d of cohortDays) {
      const dayHwids = byDay.get(d) ?? new Set<string>();
      const newOnD: string[] = [];
      dayHwids.forEach((h) => { if (firstSeen.get(h) === d) newOnD.push(h); });
      cohortSize += newOnD.length;
      const d1 = new Date(new Date(d).getTime() + 1 * dayMs).toISOString().slice(0, 10);
      const d7 = new Date(new Date(d).getTime() + 7 * dayMs).toISOString().slice(0, 10);
      const d14 = new Date(new Date(d).getTime() + 14 * dayMs).toISOString().slice(0, 10);
      const s1 = byDay.get(d1) ?? new Set<string>();
      const s7 = byDay.get(d7) ?? new Set<string>();
      const s14 = byDay.get(d14) ?? new Set<string>();
      for (const h of newOnD) {
        if (s1.has(h)) r1 += 1;
        if (s7.has(h)) r7 += 1;
        if (s14.has(h)) r14 += 1;
      }
    }
    if (cohortSize === 0) return null;
    return [
      { label: "D+1", pct: Math.round((r1 / cohortSize) * 100), n: r1, cohort: cohortSize },
      { label: "D+7", pct: Math.round((r7 / cohortSize) * 100), n: r7, cohort: cohortSize },
      { label: "D+14", pct: Math.round((r14 / cohortSize) * 100), n: r14, cohort: cohortSize },
    ];
  })();

  // Health benchmarks
  const HB = {
    sg:  cfg.stickiness_green ?? 20,
    sy:  cfg.stickiness_yellow ?? 10,
    r1g: cfg.retention_d1_green ?? 40,
    r1y: cfg.retention_d1_yellow ?? 20,
    r7g: cfg.retention_d7_green ?? 20,
    r7y: cfg.retention_d7_yellow ?? 10,
  };
  const healthBand = (val: number, green: number, yellow: number) =>
    val >= green ? "green" : val >= yellow ? "yellow" : "red";
  const bandClasses = (b: "green" | "yellow" | "red") =>
    b === "green" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
    : b === "yellow" ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
    : "bg-rose-500/15 text-rose-400 border-rose-500/30";
  const bandLabel = (b: "green" | "yellow" | "red") =>
    b === "green" ? "Healthy" : b === "yellow" ? "Watch" : "Unhealthy";

  // Drilldown openers
  const lookupGame = (gid: string | null) =>
    gid ? (gameNames[gid] || `Game ${gid}`) : "—";
  function rowsForWindow(fromDay: string, toDay: string) {
    const map = new Map<string, { checks: number; days: Set<string>; lastGame: string | null }>();
    for (const r of seen) {
      if (r.day < fromDay || r.day > toDay) continue;
      const e = map.get(r.hwid) ?? { checks: 0, days: new Set<string>(), lastGame: null };
      e.checks += r.check_count;
      e.days.add(r.day);
      if (r.last_game_id) e.lastGame = r.last_game_id;
      map.set(r.hwid, e);
    }
    return Array.from(map.entries())
      .map(([hwid, v]) => ({ hwid, checks: v.checks, days: v.days.size, lastGame: lookupGame(v.lastGame) }))
      .sort((a, b) => b.checks - a.checks);
  }
  function openDau() {
    setDrill({
      title: "DAU — Daily Active Users",
      subtitle: `Today (${todayStr}) — ${dau.toLocaleString()} unique HWIDs`,
      explanation:
        "DAU = count of distinct HWIDs that hit check_hwid at least once today. " +
        "Each row below is one HWID, sorted by number of checks today.",
      rows: rowsForWindow(todayStr, todayStr),
      meta: [{ label: "Window", value: todayStr }, { label: "Unique HWIDs", value: dau.toLocaleString() }],
    });
  }
  function openWau() {
    const from = dateNDaysAgo(6);
    setDrill({
      title: "WAU — Weekly Active Users",
      subtitle: `Last 7 days (${from} → ${todayStr}) — ${wau.toLocaleString()} unique HWIDs`,
      explanation:
        "WAU = count of distinct HWIDs that hit check_hwid at least once in the last 7 days. " +
        `Previous 7d was ${wauPrev.toLocaleString()} (${wauPct >= 0 ? "+" : ""}${wauPct}% WoW).`,
      rows: rowsForWindow(from, todayStr),
      meta: [
        { label: "Window", value: `${from} → ${todayStr}` },
        { label: "This 7d", value: wau.toLocaleString() },
        { label: "Prev 7d", value: wauPrev.toLocaleString() },
        { label: "WoW", value: `${wauPct >= 0 ? "+" : ""}${wauPct}%` },
      ],
    });
  }
  function openMau() {
    const from = dateNDaysAgo(29);
    setDrill({
      title: "MAU — Monthly Active Users",
      subtitle: `Last 30 days (${from} → ${todayStr}) — ${mau.toLocaleString()} unique HWIDs`,
      explanation:
        "MAU = count of distinct HWIDs that hit check_hwid at least once in the last 30 days. " +
        "Stickiness (DAU÷MAU) = " + stickiness + "%.",
      rows: rowsForWindow(from, todayStr),
      meta: [
        { label: "Window", value: `${from} → ${todayStr}` },
        { label: "Unique HWIDs", value: mau.toLocaleString() },
        { label: "Stickiness", value: `${stickiness}%` },
      ],
    });
  }
  function openRetention() {
    // Cohort: new HWIDs first seen 14–29 days ago (same as retentionCurve)
    const cohortRows: { hwid: string; checks: number; days: number; lastGame: string }[] = [];
    const cohortHwids = new Set<string>();
    for (const d of cohortDays) {
      const dayHwids = byDay.get(d) ?? new Set<string>();
      dayHwids.forEach((h) => { if (firstSeen.get(h) === d) cohortHwids.add(h); });
    }
    const perHwid = new Map<string, { checks: number; days: Set<string>; lastGame: string | null }>();
    for (const r of seen) {
      if (!cohortHwids.has(r.hwid)) continue;
      const e = perHwid.get(r.hwid) ?? { checks: 0, days: new Set<string>(), lastGame: null };
      e.checks += r.check_count;
      e.days.add(r.day);
      if (r.last_game_id) e.lastGame = r.last_game_id;
      perHwid.set(r.hwid, e);
    }
    perHwid.forEach((v, hwid) => {
      cohortRows.push({ hwid, checks: v.checks, days: v.days.size, lastGame: lookupGame(v.lastGame) });
    });
    cohortRows.sort((a, b) => b.days - a.days);
    const meta: { label: string; value: string }[] = [
      { label: "Cohort size", value: cohortHwids.size.toLocaleString() },
      { label: "Cohort window", value: `${cohortDays[0] ?? "—"} → ${cohortDays[cohortDays.length-1] ?? "—"}` },
    ];
    if (retentionCurve) {
      for (const p of retentionCurve) meta.push({ label: p.label, value: `${p.pct}% (${p.n}/${p.cohort})` });
    }
    setDrill({
      title: "Retention cohort",
      subtitle: "HWIDs that were first seen 14–29 days ago",
      explanation:
        "A 'retention cohort' is a group of brand-new users from one window. " +
        "We track how many of them came back N days after their first visit. " +
        "Higher % = your service is sticky; users return. Lower % = users try it once and leave.",
      rows: cohortRows,
      meta,
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Checks today" value={today?.total_checks ?? 0} hint="Every time the script pings the server" />
        <StatCard label="Sessions started today" value={today?.sessions_started ?? 0} hint="New users who got a fresh session" />
        <StatCard label="Active now" value={today?.active_at_snapshot ?? 0} hint="Currently playing with the script" />
        <StatCard label="On cooldown now" value={today?.cooldown_at_snapshot ?? 0} hint="Waiting to use again" />
      </div>

      {/* Auto health-check alerts */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              Auto health checks
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              A scheduled job runs once a day (00:15 UTC) and compares this week vs last week.
              If active users or retention drop by more than your configured thresholds, an alert is logged here.
              Click <strong>Run now</strong> to recompute on demand.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={runChecksNow} disabled={runningChecks}>
            {runningChecks ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
            Run now
          </Button>
        </div>
        {alerts.length === 0 ? (
          <div className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
            <strong>All clear.</strong> No active alerts. Every monitored metric is within your configured thresholds.
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {alerts.map((a) => {
              const sev = a.severity === "critical" ? "bg-rose-500/15 text-rose-400 border-rose-500/40"
                : a.severity === "warning" ? "bg-amber-500/15 text-amber-400 border-amber-500/40"
                : "bg-sky-500/15 text-sky-400 border-sky-500/40";
              const explainKind: Record<string, string> = {
                wau_drop: "Weekly Active Users (unique HWIDs in last 7 days) fell sharply compared to the prior 7-day window. This usually means: a meta-change in the games you target, an obfuscation break, or competitor activity.",
                dau_drop: "Today's Daily Active Users came in well below the trailing 7-day average. One bad day can be noise (weekend, outage), but repeated DAU dips are an early warning of churn.",
                retention_drop: "Day-1 retention (the % of brand-new HWIDs that come back the next day) fell vs last week's cohort. New users are signing up but not returning — first-run quality, gate friction, or a broken script are likely causes.",
              };
              return (
                <div key={a.id} className="rounded-md border border-border bg-background/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${sev}`}>{a.severity}</span>
                    <span className="text-xs font-mono text-muted-foreground">{a.kind}</span>
                    <span className="text-[11px] text-muted-foreground ml-auto">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                  <div className="mt-1.5 text-sm font-medium">{a.message}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{explainKind[a.kind] ?? "Custom health check flagged this metric."}</div>
                  {a.details && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      {Object.entries(a.details).filter(([k]) => k !== "kind" && k !== "message").map(([k, v]) => (
                        <span key={k}><span className="text-foreground">{k}</span>: {String(v)}</span>
                      ))}
                    </div>
                  )}
                  <div className="mt-2">
                    <button onClick={() => acknowledgeAlert(a.id)} className="rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:border-primary/50">
                      Acknowledge
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Last 7d · checks" value={sum("total_checks")} hint="rolling sum" />
        <StatCard label="Last 7d · sessions" value={sum("sessions_started")} hint="rolling sum" />
        <StatCard label="Last 7d · cooldowns cleared" value={sum("cooldowns_cleared")} hint="auto-deleted by cron" />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm font-semibold">Daily traffic (last 30 days)</div>
            <div className="text-xs text-muted-foreground">Bar height = total checks. Stored permanently in analytics_daily.</div>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">No data yet — analytics start recording on the next check.</div>
        ) : (
          <>
            <div className="h-64 w-full mb-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={rows.slice().reverse().map((r) => ({
                    day: r.day.slice(5),
                    checks: r.total_checks,
                    sessions: r.sessions_started,
                  }))}
                  margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    cursor={{ fill: "color-mix(in oklab, var(--muted) 40%, transparent)" }}
                    contentStyle={{
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="checks" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="sessions" fill="color-mix(in oklab, var(--primary) 45%, transparent)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2">Day</th>
                    <th className="px-2 py-2 text-right">Checks</th>
                    <th className="px-2 py-2 text-right">Sessions</th>
                    <th className="px-2 py-2 text-right">Cooldowns cleared</th>
                    <th className="px-2 py-2 text-right">Unique HWIDs</th>
                    <th className="px-2 py-2 text-right">Active</th>
                    <th className="px-2 py-2 text-right">Cooldown</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.day} className="border-t border-border">
                      <td className="px-2 py-2 font-mono">{r.day}</td>
                      <td className="px-2 py-2 text-right font-mono">{r.total_checks}</td>
                      <td className="px-2 py-2 text-right font-mono">{r.sessions_started}</td>
                      <td className="px-2 py-2 text-right font-mono">{r.cooldowns_cleared}</td>
                      <td className="px-2 py-2 text-right font-mono">{r.unique_hwids}</td>
                      <td className="px-2 py-2 text-right font-mono">{r.active_at_snapshot}</td>
                      <td className="px-2 py-2 text-right font-mono">{r.cooldown_at_snapshot}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* 7d vs prev 7d delta cards */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-sm font-semibold mb-1">This 7 days vs previous 7 days</div>
        <div className="text-xs text-muted-foreground mb-4">Growth check — is traffic going up or down?</div>
        <div className="grid gap-4 md:grid-cols-4">
          {compareCards.map((c) => {
            const up = c.delta >= 0;
            return (
              <div key={c.key} className="rounded-lg border border-border bg-background/40 p-4">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">{c.label}</div>
                <div className="mt-2 font-display text-2xl font-semibold">{c.cur.toLocaleString()}</div>
                <div className="mt-1 text-xs text-muted-foreground">prev: {c.prev.toLocaleString()}</div>
                <div className={`mt-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${up ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"}`}>
                  {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                  {up ? "+" : ""}{c.delta.toLocaleString()} ({up ? "+" : ""}{c.pct}%)
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Growth & Engagement — SaaS-style metrics */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-sm font-semibold mb-1">Growth & Engagement</div>
        <div className="text-xs text-muted-foreground mb-2">
          DAU/WAU/MAU = unique HWIDs active today / last 7d / last 30d. Stickiness = DAU÷MAU. Click any card to drill down into the HWIDs behind the number.
        </div>
        <div className="mb-4 flex flex-wrap gap-2 text-[10px]">
          <span className={`rounded-md border px-1.5 py-0.5 ${bandClasses("green")}`}>Green = healthy</span>
          <span className={`rounded-md border px-1.5 py-0.5 ${bandClasses("yellow")}`}>Yellow = watch</span>
          <span className={`rounded-md border px-1.5 py-0.5 ${bandClasses("red")}`}>Red = unhealthy</span>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <button type="button" onClick={openDau} className="text-left rounded-lg border border-border bg-background/40 p-4 hover:border-primary/40 transition">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">DAU</div>
            <div className="mt-2 font-display text-2xl font-semibold">{dau.toLocaleString()}</div>
            <div className="mt-1 text-xs text-muted-foreground">unique HWIDs today</div>
          </button>
          <button type="button" onClick={openWau} className="text-left rounded-lg border border-border bg-background/40 p-4 hover:border-primary/40 transition">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">WAU</div>
            <div className="mt-2 font-display text-2xl font-semibold">{wau.toLocaleString()}</div>
            <div className={`mt-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${wauDelta >= 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"}`}>
              {wauDelta >= 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {wauDelta >= 0 ? "+" : ""}{wauPct}% WoW
            </div>
          </button>
          <button type="button" onClick={openMau} className="text-left rounded-lg border border-border bg-background/40 p-4 hover:border-primary/40 transition">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">MAU</div>
            <div className="mt-2 font-display text-2xl font-semibold">{mau.toLocaleString()}</div>
            <div className="mt-1 text-xs text-muted-foreground">unique HWIDs in last 30d</div>
          </button>
          <button type="button" onClick={openMau} className="text-left rounded-lg border border-border bg-background/40 p-4 hover:border-primary/40 transition">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Stickiness</div>
            <div className="mt-2 font-display text-2xl font-semibold">{stickiness}%</div>
            {(() => {
              const band = healthBand(stickiness, HB.sg, HB.sy);
              return (
                <div className={`mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${bandClasses(band)}`}>
                  {bandLabel(band)} (green ≥ {HB.sg}%, yellow ≥ {HB.sy}%)
                </div>
              );
            })()}
          </button>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-background/40 p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">New vs Returning today</div>
            <div className="flex items-end gap-4">
              <div>
                <div className="font-display text-2xl font-semibold text-primary">{newToday.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">New HWIDs</div>
              </div>
              <div>
                <div className="font-display text-2xl font-semibold">{returningToday.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Returning</div>
              </div>
            </div>
            {todayHwids.size > 0 && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.round((newToday / todayHwids.size) * 100)}%` }}
                />
              </div>
            )}
          </div>

          <button type="button" onClick={openRetention} className="text-left rounded-lg border border-border bg-background/40 p-4 hover:border-primary/40 transition">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Retention curve</div>
            {retentionCurve ? (
              <div className="grid grid-cols-3 gap-3">
                {retentionCurve.map((p) => {
                  const band = p.label === "D+1"
                    ? healthBand(p.pct, HB.r1g, HB.r1y)
                    : p.label === "D+7"
                      ? healthBand(p.pct, HB.r7g, HB.r7y)
                      : healthBand(p.pct, Math.max(5, Math.round(HB.r7g / 2)), Math.max(2, Math.round(HB.r7y / 2)));
                  return (
                    <div key={p.label} className={`rounded-md border p-3 text-center ${bandClasses(band)}`}>
                      <div className="text-xs opacity-80">{p.label}</div>
                      <div className="mt-1 font-display text-xl font-semibold">{p.pct}%</div>
                      <div className="text-[10px] opacity-80">{p.n}/{p.cohort}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-4 text-center text-xs text-muted-foreground">Need 14+ days of HWID history to compute.</div>
            )}
            <div className="mt-3 text-[11px] text-muted-foreground">Click to view the cohort HWIDs and per-window pass rates.</div>
          </button>
        </div>

        <div className="mt-6">
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">New HWIDs per day (last 14d)</div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={newPerDay} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: "color-mix(in oklab, var(--muted) 40%, transparent)" }}
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="new_hwids" name="New" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="total_hwids" name="Total active" fill="color-mix(in oklab, var(--primary) 35%, transparent)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Hourly traffic today */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-sm font-semibold mb-1">Hourly traffic — today</div>
        <div className="text-xs text-muted-foreground mb-4">Checks and sessions started by hour. All times in UTC.</div>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hourlyData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="hour" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} interval={1} />
              <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: "color-mix(in oklab, var(--muted) 40%, transparent)" }}
                contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="checks" fill="var(--primary)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="sessions" fill="color-mix(in oklab, var(--primary) 45%, transparent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Per-game analytics */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-sm font-semibold mb-1">Top games — last 7 days</div>
        <div className="text-xs text-muted-foreground mb-4">Which games are driving the traffic.</div>
        {perGame.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No game-tagged checks in the window yet.</div>
        ) : (
          <>
            <div className="h-64 w-full mb-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={perGame} layout="vertical" margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} width={140} />
                  <Tooltip cursor={{ fill: "color-mix(in oklab, var(--muted) 40%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="checks" fill="var(--primary)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2">Game</th>
                    <th className="px-2 py-2 text-right">Checks</th>
                    <th className="px-2 py-2 text-right">Sessions</th>
                    <th className="px-2 py-2 text-right">Unique HWIDs</th>
                  </tr>
                </thead>
                <tbody>
                  {perGame.map((g) => (
                    <tr key={g.gameId} className="border-t border-border">
                      <td className="px-2 py-2">
                        <div className="font-medium">{g.name}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">{g.gameId}</div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono">{g.checks.toLocaleString()}</td>
                      <td className="px-2 py-2 text-right font-mono">{g.sessions.toLocaleString()}</td>
                      <td className="px-2 py-2 text-right font-mono">{g.hwids.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Retention */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="text-sm font-semibold mb-1">Day-1 retention</div>
        <div className="text-xs text-muted-foreground mb-4">% of HWIDs seen on day X that came back on day X+1.</div>
        {retention.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Need at least 2 days of HWID data.</div>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={retention} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  cursor={{ fill: "color-mix(in oklab, var(--muted) 40%, transparent)" }}
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  formatter={(_v, _n, p: any) => [`${p?.payload?.pct}% (${p?.payload?.returned}/${p?.payload?.cohort})`, "D+1 retention"]}
                />
                <Bar dataKey="pct" fill="var(--primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Top HWIDs */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-sm font-semibold">Heaviest users — last 7 days</div>
            <div className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
              Ranked by total checks. <span className="text-foreground font-medium">Activity</span> shows which of the last 7 days they were active (filled dot = active). <span className="text-foreground font-medium">Avg/active day</span> = checks ÷ days active. <span className="text-foreground font-medium">Velocity</span> = peak granted sessions in a single minute over 7d (4+ is suspicious, 10+ likely automation). <span className="text-foreground font-medium">Risk</span> badge flags likely bots. <span className="text-primary font-medium">Click any row</span> for full per-day + per-session history.
            </div>
          </div>
        </div>
        {topHwids.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No HWID activity in the window yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 w-8">#</th>
                  <th className="px-2 py-2">HWID</th>
                  <th className="px-2 py-2">Last game</th>
                  <th className="px-2 py-2">Last active</th>
                  <th className="px-2 py-2 text-center" title="Filled = active that day. Leftmost = 6 days ago, rightmost = today.">Activity (last 7d)</th>
                  <th className="px-2 py-2 text-right">Checks</th>
                  <th className="px-2 py-2 text-right" title="Total checks divided by number of days active">Avg / active day</th>
                  <th className="px-2 py-2 text-right" title="Peak number of session-grants in a single minute over the last 7 days. High velocity = automated/scripted client.">Velocity (peak/min)</th>
                  <th className="px-2 py-2 text-center">Risk</th>
                </tr>
              </thead>
              <tbody>
                {topHwids.map((h, i) => {
                  const last7Days = Array.from({ length: 7 }, (_, idx) => {
                    const d = new Date(Date.now() - (6 - idx) * dayMs).toISOString().slice(0, 10);
                    return d;
                  });
                  const activeSet = new Set(
                    seen7.filter((r) => r.hwid === h.hwid).map((r) => r.day),
                  );
                  const lastActiveLabel = (() => {
                    if (!h.lastDay) return "—";
                    const diff = Math.floor((Date.now() - new Date(h.lastDay).getTime()) / dayMs);
                    if (diff <= 0) return "Today";
                    if (diff === 1) return "Yesterday";
                    return `${diff}d ago`;
                  })();
                  const riskStyle =
                    h.risk === "high"
                      ? "bg-red-500/15 text-red-400 border-red-500/30"
                      : h.risk === "medium"
                        ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                        : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
                  const riskLabel = h.risk === "high" ? "Likely bot" : h.risk === "medium" ? "Heavy" : "Normal";
                  const vel = velocityMap[h.hwid];
                  const velPeak = vel?.peak ?? 0;
                  const velStyle = velPeak >= 10 ? "text-red-400" : velPeak >= 4 ? "text-amber-400" : "text-muted-foreground";
                  return (
                    <tr
                      key={h.hwid}
                      className="border-t border-border hover:bg-muted/40 cursor-pointer"
                      onClick={() => openHwidDrill({ hwid: h.hwid, gameName: h.gameName, checks: h.checks, days: h.days })}
                      title="Click to view full activity"
                    >
                      <td className="px-2 py-2 text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-2 font-mono truncate max-w-[220px]" title={h.hwid}>{h.hwid}</td>
                      <td className="px-2 py-2 truncate max-w-[180px]" title={h.gameName}>{h.gameName}</td>
                      <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{lastActiveLabel}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-center gap-1" title={`Active on ${h.days} of the last 7 days`}>
                          {last7Days.map((d) => {
                            const on = activeSet.has(d);
                            return (
                              <span
                                key={d}
                                className={`h-2.5 w-2.5 rounded-full ${on ? "bg-primary" : "bg-muted-foreground/20"}`}
                                title={`${d} — ${on ? "active" : "no activity"}`}
                              />
                            );
                          })}
                          <span className="ml-2 text-muted-foreground tabular-nums">{h.days}/7</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono">{h.checks.toLocaleString()}</td>
                      <td className="px-2 py-2 text-right font-mono text-muted-foreground">{h.avgPerActiveDay.toLocaleString()}</td>
                      <td className={`px-2 py-2 text-right font-mono ${velStyle}`} title={vel?.at ? `Peak at ${new Date(vel.at).toLocaleString()}` : "No session data yet"}>
                        {vel ? velPeak : "…"}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${riskStyle}`}>
                          {riskLabel}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Sheet open={!!drill} onOpenChange={(o) => { if (!o) setDrill(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto bg-card/95 backdrop-blur-xl border-l border-border">
          {drill && (
            <>
              <SheetHeader>
                <SheetTitle className="font-display text-xl">{drill.title}</SheetTitle>
                <SheetDescription className="text-xs">{drill.subtitle}</SheetDescription>
              </SheetHeader>
              <div className="mt-4 rounded-md border border-border bg-background/40 p-3 text-xs text-muted-foreground">
                <strong className="text-foreground">What this means: </strong>{drill.explanation}
              </div>
              {drill.meta && drill.meta.length > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  {drill.meta.map((m) => (
                    <div key={m.label} className="rounded-md border border-border bg-background/40 p-2">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.label}</div>
                      <div className="mt-0.5 font-mono">{m.value}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 mb-2 flex items-center justify-between">
                <div className="text-xs text-muted-foreground">{drill.rows.length.toLocaleString()} HWIDs in this set</div>
                <button
                  onClick={() => {
                    const header = "hwid,checks,active_days,last_game\n";
                    const csv = header + drill.rows.map((r) => `${r.hwid},${r.checks},${r.days},"${r.lastGame.replace(/"/g, '""')}"`).join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = `${drill.title.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.csv`;
                    a.click(); URL.revokeObjectURL(url);
                  }}
                  className="text-[11px] rounded-md border border-border px-2 py-1 hover:border-primary/40"
                >
                  Export CSV
                </button>
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-background/40 text-left text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2">#</th>
                      <th className="px-2 py-2">HWID</th>
                      <th className="px-2 py-2">Last game</th>
                      <th className="px-2 py-2 text-right">Checks</th>
                      <th className="px-2 py-2 text-right">Active days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drill.rows.slice(0, 500).map((r, i) => (
                      <tr key={r.hwid} className="border-t border-border">
                        <td className="px-2 py-2 text-muted-foreground">{i + 1}</td>
                        <td className="px-2 py-2 font-mono truncate max-w-[260px]" title={r.hwid}>{r.hwid}</td>
                        <td className="px-2 py-2">{r.lastGame}</td>
                        <td className="px-2 py-2 text-right font-mono">{r.checks.toLocaleString()}</td>
                        <td className="px-2 py-2 text-right font-mono">{r.days}</td>
                      </tr>
                    ))}
                    {drill.rows.length === 0 && (
                      <tr><td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">No HWIDs in this window yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {drill.rows.length > 500 && (
                <div className="mt-2 text-[11px] text-muted-foreground">Showing first 500 — full set in CSV export.</div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      <Sheet open={!!hwidDrill} onOpenChange={(o) => { if (!o) setHwidDrill(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto bg-card/95 backdrop-blur-xl border-l border-border">
          {hwidDrill && (
            <>
              <SheetHeader>
                <SheetTitle className="font-display text-xl">HWID activity</SheetTitle>
                <SheetDescription className="text-xs font-mono break-all">{hwidDrill.hwid}</SheetDescription>
              </SheetHeader>
              <div className="mt-4 rounded-md border border-border bg-background/40 p-3 text-xs text-muted-foreground">
                <strong className="text-foreground">What this means: </strong>
                Per-day check totals come from <code>hwid_daily_seen</code> (last 30 days). Per-session rows come from <code>sessions</code> (last 7 days) — one row each time the loader was granted access. <strong className="text-foreground">Velocity</strong> is the highest number of grants in any single minute over the last 7 days; values above 4 suggest a script firing the loader on a loop.
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                <div className="rounded-md border border-border bg-background/40 p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Checks (7d)</div>
                  <div className="mt-0.5 font-mono">{hwidDrill.totalChecks.toLocaleString()}</div>
                </div>
                <div className="rounded-md border border-border bg-background/40 p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Days active</div>
                  <div className="mt-0.5 font-mono">{hwidDrill.daysActive}/7</div>
                </div>
                <div className="rounded-md border border-border bg-background/40 p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Peak/min</div>
                  <div className="mt-0.5 font-mono">{hwidDrill.peakPerMin || "—"}</div>
                </div>
                <div className="rounded-md border border-border bg-background/40 p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Last game</div>
                  <div className="mt-0.5 truncate" title={hwidDrill.lastGame}>{hwidDrill.lastGame}</div>
                </div>
              </div>
              {hwidDrill.peakAt && (
                <div className="mt-2 text-[11px] text-muted-foreground">
                  Peak occurred at <span className="text-foreground font-mono">{new Date(hwidDrill.peakAt).toLocaleString()}</span>.
                </div>
              )}

              {hwidDrill.loading ? (
                <div className="mt-6 text-center text-sm text-muted-foreground">Loading activity…</div>
              ) : (
                <>
                  <div className="mt-5 mb-2 text-xs font-semibold">Daily activity (last 30 days)</div>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-background/40 text-left text-muted-foreground">
                        <tr>
                          <th className="px-2 py-2">Day</th>
                          <th className="px-2 py-2 text-right">Checks</th>
                          <th className="px-2 py-2 text-right">Sessions started</th>
                          <th className="px-2 py-2">Last game</th>
                          <th className="px-2 py-2">Last seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hwidDrill.daily.length === 0 ? (
                          <tr><td colSpan={5} className="px-2 py-4 text-center text-muted-foreground">No daily activity recorded.</td></tr>
                        ) : hwidDrill.daily.map((d) => (
                          <tr key={d.day} className="border-t border-border">
                            <td className="px-2 py-2 font-mono">{d.day}</td>
                            <td className="px-2 py-2 text-right font-mono">{d.checks.toLocaleString()}</td>
                            <td className="px-2 py-2 text-right font-mono">{d.sessions.toLocaleString()}</td>
                            <td className="px-2 py-2 truncate max-w-[180px]" title={d.lastGame}>{d.lastGame}</td>
                            <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-5 mb-2 flex items-center justify-between">
                    <div className="text-xs font-semibold">Per-session log (last 7 days)</div>
                    <button
                      onClick={() => {
                        const header = "created_at,script_url\n";
                        const csv = header + hwidDrill.sessions.map((s) => `${s.created_at},"${(s.script_url ?? "").replace(/"/g, '""')}"`).join("\n");
                        const blob = new Blob([csv], { type: "text/csv" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url; a.download = `hwid-${hwidDrill.hwid.slice(0, 24)}-sessions.csv`;
                        a.click(); URL.revokeObjectURL(url);
                      }}
                      className="text-[11px] rounded-md border border-border px-2 py-1 hover:border-primary/40"
                    >
                      Export CSV
                    </button>
                  </div>
                  <div className="overflow-x-auto rounded-md border border-border max-h-[400px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-background/40 text-left text-muted-foreground sticky top-0">
                        <tr>
                          <th className="px-2 py-2 w-8">#</th>
                          <th className="px-2 py-2">Timestamp</th>
                          <th className="px-2 py-2">Script</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hwidDrill.sessions.length === 0 ? (
                          <tr><td colSpan={3} className="px-2 py-4 text-center text-muted-foreground">No sessions in the last 7 days.</td></tr>
                        ) : hwidDrill.sessions.map((s, i) => (
                          <tr key={i} className="border-t border-border">
                            <td className="px-2 py-2 text-muted-foreground">{i + 1}</td>
                            <td className="px-2 py-2 font-mono whitespace-nowrap">{new Date(s.created_at).toLocaleString()}</td>
                            <td className="px-2 py-2 truncate max-w-[280px] font-mono text-muted-foreground" title={s.script_url ?? ""}>{s.script_url ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {hwidDrill.sessions.length >= 500 && (
                    <div className="mt-2 text-[11px] text-muted-foreground">Showing most recent 500 sessions.</div>
                  )}
                </>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-2 font-display text-3xl font-semibold">{value.toLocaleString()}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

