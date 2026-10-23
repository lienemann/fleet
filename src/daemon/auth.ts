import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

/** Where a daemon keeps its secret, and the secrets of the remote daemons it relays to. */
export const secretFile = (home: string): string => join(home, "secret");
export const remoteSecretFile = (home: string, remote: string): string =>
  join(home, "remotes", `${remote}.secret`);

/** Files a browser fetches without cookies: installing the app needs the manifest and icons. */
const PUBLIC = /^\/(manifest\.webmanifest|icon[\w-]*\.(png|svg)|apple-touch-icon\.png)$/;

const MAX_FORM = 4096;

/**
 * The daemon's secret, made on first start. Only its owner may read it, so another user of the
 * same computer cannot reach the daemon even though it listens on a loopback port they share.
 */
export function loadSecret(home: string): string {
  const file = secretFile(home);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}

/** The secret of a remote daemon, copied from its host, if there is one. */
export function loadRemoteSecret(home: string, remote: string): string | undefined {
  const file = remoteSecretFile(home, remote);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Who may talk to the daemon: tools that send the secret as a bearer token, and browsers with
 * the cookie they got by logging in with it. The cookie holds a value derived from the secret,
 * never the secret itself, and its name differs per daemon, since cookies ignore the port.
 */
export class Auth {
  readonly cookieName: string;
  private readonly secret: string;
  private readonly session: string;

  constructor(secret: string) {
    this.secret = secret;
    this.session = createHmac("sha256", secret).update("fleet session").digest("base64url");
    this.cookieName = `fleet_${createHash("sha256").update(`name:${secret}`).digest("hex").slice(0, 8)}`;
  }

  /** The cookie a logged-in browser sends; tests and Playwright set it directly. */
  get cookie(): string {
    return `${this.cookieName}=${this.session}`;
  }

  /** Whether a request may go on: it carries the secret or the session cookie, or needs neither. */
  allows(req: IncomingMessage): boolean {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (PUBLIC.test(path)) return true;
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && same(bearer, this.secret)) return true;
    const cookie = req.headers.cookie
      ?.split(/;\s*/)
      .find((c) => c.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1);
    return cookie !== undefined && same(cookie, this.session);
  }

  /**
   * Answers a request that `allows` refused, or one for /login: a page asks for the secret,
   * and the secret (typed in, or in the link `fleet login` prints) sets the cookie.
   */
  async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/login") {
      const page = req.method === "GET" && req.headers.accept?.includes("text/html");
      if (page) loginPage(res, 401);
      else res.writeHead(401).end();
      return;
    }
    const given = req.method === "POST" ? await formSecret(req) : url.searchParams.get("secret");
    if (given === null) {
      loginPage(res, 200);
    } else if (same(given.trim(), this.secret)) {
      res
        .writeHead(303, {
          location: "/",
          "set-cookie": `${this.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        })
        .end();
    } else {
      loginPage(res, 401, "That is not this daemon's secret.");
    }
  }
}

/** The link that logs a browser in, as `fleet login` prints it. */
export const loginLink = (port: number, secret: string): string =>
  `http://127.0.0.1:${port}/login?secret=${encodeURIComponent(secret)}`;

async function formSecret(req: IncomingMessage): Promise<string | null> {
  let body = "";
  for await (const chunk of req as AsyncIterable<Buffer>) {
    body += chunk.toString("utf8");
    if (body.length > MAX_FORM) return null;
  }
  return new URLSearchParams(body).get("secret");
}

function loginPage(res: ServerResponse, status: number, error?: string): void {
  res
    .writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
    .end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet: log in</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: light dark; --bg: #f6f0e6; --fg: #2b2320; --muted: #7a6d63; --line: #dccfbe; --accent: #8c1d2b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1218; --fg: #e3e7ef; --muted: #8a93a6; --line: #2a3142; --accent: #6aa8ff; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
  form { display: flex; flex-direction: column; gap: 10px; width: min(420px, calc(100vw - 32px)); }
  h1 { margin: 0; font-size: 20px; }
  p { margin: 0; color: var(--muted); }
  code { font-family: ui-monospace, monospace; }
  input { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: 13px ui-monospace, monospace; }
  button { align-self: flex-start; padding: 7px 14px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
  .error { color: #d9534f; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>fleet</h1>
  <p>This daemon only answers its owner. Open the link that <code>fleet login</code> prints, or paste the secret from <code>~/.fleet/secret</code>.</p>
  ${error ? `<p class="error">${error}</p>` : ""}
  <input name="secret" type="password" aria-label="Secret" autocomplete="current-password" autofocus required>
  <button type="submit">Log in</button>
</form>
</body>
</html>
`);
}
