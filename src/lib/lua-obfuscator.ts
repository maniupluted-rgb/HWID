// Server-side Lua loader protection (ported from WickShop "script-loader").
// 1. isBrowserRequest — block HTML/browser callers (only Roblox HttpGet should hit it)
// 2. obfuscateScript — XOR-encrypt the Lua source + wrap in a tiny in-Lua decoder
//    with random variable names and dead code, so the body served over the wire
//    is unreadable even if someone captures the response.

// NOTE: We intentionally do NOT block on User-Agent strings. Mobile Roblox
// executors (Delta, Codex, Arceus X, Hydrogen, etc.) are WebView-based and
// send browser-like UAs (Mozilla/WebKit/Safari/Chrome). Blocking those UAs
// would 403 every mobile user. Real browsers can be reliably distinguished
// by the sec-fetch-* headers and an `Accept: text/html` request, which no
// Roblox HttpGet sends.
export function isBrowserRequest(req: Request): boolean {
  const accept = req.headers.get("accept") || "";
  const secFetchDest = req.headers.get("sec-fetch-dest") || "";
  const secFetchMode = req.headers.get("sec-fetch-mode") || "";
  const secFetchSite = req.headers.get("sec-fetch-site") || "";

  if (secFetchDest === "document" || secFetchDest === "iframe") return true;
  if (secFetchMode === "navigate") return true;
  // Any sec-fetch-site header at all is a browser signal (Roblox HttpGet
  // doesn't emit these). Combined with html accept it's a hard browser tell.
  if (secFetchSite && accept.includes("text/html")) return true;
  if (accept.includes("text/html")) return true;
  return false;
}

function xorEncrypt(input: string, key: number): number[] {
  // Encode to UTF-8 BYTES first (each 0-255). Using charCodeAt() here was the bug:
  // for any non-ASCII char (emoji, •, —, ✅ …) it returns a UTF-16 code unit > 255,
  // and Lua's string.char() errors on values > 255 — so the whole decoder threw and
  // the script never ran. UTF-8 bytes keep every value in range, and concatenating
  // them in Lua rebuilds the exact source (Lua strings are byte strings).
  const bytes = new TextEncoder().encode(input);
  const result: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    result.push(bytes[i] ^ ((key + i * 37) & 0xFF));
  }
  return result;
}

function rand(n: number) {
  return Math.floor(Math.random() * n);
}

function generateRandomName(len = 8): string {
  const chars = "abcdefghijklmnopqrstuvwxyz_";
  let name = chars[rand(26)];
  for (let i = 1; i < len; i++) name += chars[rand(chars.length)];
  return name;
}

function generateDeadCode(): string {
  const lines: string[] = [];
  const count = 2 + rand(3);
  for (let i = 0; i < count; i++) {
    const v = generateRandomName(6);
    const op = Math.random() > 0.5 ? "math.random()" : `tostring(${rand(9999)})`;
    lines.push(`local ${v} = ${op}`);
  }
  return lines.join("\n");
}

export function obfuscateScript(luaCode: string): string {
  const xorKey = rand(200) + 50;
  const encrypted = xorEncrypt(luaCode, xorKey);

  const vData = generateRandomName(10);
  const vKey = generateRandomName(8);
  const vResult = generateRandomName(9);
  const vFunc = generateRandomName(8);
  const vXor = generateRandomName(7);

  return `-- Protected by WickGuard v2
${generateDeadCode()}
local ${vXor} = function(a, b)
  local r, m = 0, 1
  while a > 0 or b > 0 do
    local x, y = a % 2, b % 2
    if x ~= y then r = r + m end
    a, b, m = math.floor(a / 2), math.floor(b / 2), m * 2
  end
  return r
end
${generateDeadCode()}
local ${vData} = {${encrypted.join(",")}}
local ${vKey} = ${xorKey}
local ${vResult} = {}
for i = 1, #${vData} do
  local k = (${vKey} + (i-1) * 37) % 256
  ${vResult}[i] = string.char(${vXor}(${vData}[i], k))
end
local ${vFunc} = table.concat(${vResult})
local _E = loadstring or load
if _E then _E(${vFunc})() end
`;
}