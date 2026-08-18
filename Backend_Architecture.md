# CST · Backend Architecture (zero-cost)

**Audience:** whoever builds the server side of CST, and anyone forking the
repo who wants their own instance.

**Status:** design proposal. Nothing here is built yet. It supersedes the
one-line "Persistence MVP" bullet in `ARCHITECTURE.md` §12 and the
persistence sketch in `End_to_End_Design.md`.

**Companion docs:** `ARCHITECTURE.md` (client, authoritative for everything
below the API boundary), `IRC_Street_Designer_Plan_v2.md` (scope/phases),
`CLAUDE.md` (working rules).

---

## 0. Decisions & pushback (read first)

1. **The client-only decision stays intact.** Nothing in this document moves
   geometry, junction derivation, transitions, rules, or export to a server.
   The server stores **opaque bytes** and **who owns them**. This is not
   only architectural hygiene — the free Workers tier gives 10 ms CPU per
   request, which is not enough to parse a 400 KB design JSON, let alone
   derive junctions. Treat "the server must never look inside a design" as a
   hard rule, and every free-tier limit stops mattering.

2. **The app must keep working with no backend at all.** Default build =
   local-first: IndexedDB autosave + `.cst.json` file open/save. The cloud
   is an *optional adapter* enabled by one env var (`VITE_API_BASE`). A fork
   with no Cloudflare account gets a fully working tool. This is also what
   makes the backend safe to build incrementally — B0 below ships real user
   value with zero infrastructure.

3. **Recommended stack: Cloudflare Workers + D1, with GitHub/Google OAuth
   implemented in the Worker (~600 lines).** Not Supabase, not Firebase. Two
   reasons, both about the words "zero cost" and "open source": Supabase
   free projects **pause after 7 days of inactivity** (fatal for a tool with
   bursty academic usage), and every BaaS free tier caps monthly active
   users, so success becomes a bill. Workers + D1 needs **no credit card on
   file** and no MAU ceiling — only request/row caps that we can design
   around. Rejected options are tabulated in §15.

4. **Deliberately avoided: R2.** Enabling R2 requires adding a payment
   method to the Cloudflare account, which breaks "no card anywhere". D1's
   2 MB row limit is comfortably above a gzipped design (~30–80 KB), so
   blobs live in D1 and R2 stays out until it's genuinely needed (§5.4).

5. **One thing I'd push back on if you asked for it: real-time
   collaborative editing.** It is technically free (Durable Objects, 100 k
   req/day) but it would force CRDT semantics onto a store whose whole
   architecture is "derived, not stored" with a single linear undo history.
   That is a rewrite of `store.ts`, not a backend feature. Share links +
   fork-a-copy covers 90 % of the need for a design tool at 0 % of the cost.

**Cost of the recommended design: ₹0 / $0, no payment method on any
account.** Optional spends, both avoidable: a domain name (~₹900/yr) for a
nicer URL and edge caching, and Workers Paid ($5/mo) if the tool outgrows
§11's caps.

---

## 1. Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Local-first.** The browser is the source of truth during a session. | Cloud sync is a background push, never a blocking round-trip. Airplane-mode works. |
| P2 | **The server stores opaque, client-compressed bytes.** | No server-side JSON parse, no gzip, no schema logic → fits 10 ms CPU. Client uses `CompressionStream('gzip')`. |
| P3 | **Anonymous by default; login only unlocks sync + sharing.** | Most users never create an account → auth cost, abuse surface, and privacy liability all shrink. |
| P4 | **No passwords, ever.** OAuth only (GitHub, Google). | No password hashes, no reset emails, no email-sending dependency, no credential-breach liability. |
| P5 | **Minimum PII.** Provider id + email + display handle. Nothing else. | One-click delete is genuinely complete (§12). |
| P6 | **Every stored artifact is exportable as a file the user already has.** | Vendor exit is `.cst.json` download; D1 is SQLite, exportable with one command. |
| P7 | **Free-tier caps are product rules, not surprises.** | Quotas are enforced in code and shown in the UI (§11) rather than discovered as 429s. |

---

## 2. Stack

| Concern | Choice | Free-tier headroom (verified Aug 2026) |
|---|---|---|
| Static app hosting | **Cloudflare Workers static assets** (canonical) + GitHub Pages (mirror, local-only mode) | Static asset requests free & unlimited; 20 000 files/version, 25 MiB/file. GH Pages: 1 GB repo, 100 GB/mo soft bandwidth |
| API runtime | **Cloudflare Workers** (single Worker, `/api/*`) | 100 000 req/day, 10 ms CPU/req, 128 MB, 50 subrequests/req |
| Database | **Cloudflare D1** (SQLite) | 500 MB/db, 10 dbs, 5 GB/account, 5 M rows read/day, 100 k rows written/day, 2 MB max row, 50 queries/invocation |
| Design blobs & thumbnails | **D1 BLOB** (gzipped client-side) | see §5.4 storage math |
| Sessions | D1 table + HttpOnly cookie (HMAC-signed id) | negligible |
| Identity providers | **GitHub OAuth App** + **Google OAuth client** | free, unmetered |
| Local persistence | **IndexedDB** (`idb-keyval`) + File System Access API | free, ~GBs |
| Bot/abuse gate on public writes | **Cloudflare Turnstile** | free |
| CI/CD | **GitHub Actions** (public repo → free standard runners) | free |
| Backups | Actions cron → `wrangler d1 export` → artifact | free (90-day artifact retention) |
| Analytics | Cloudflare Web Analytics *or* GoatCounter (free for OSS) | cookieless, free |
| Error reporting | Sentry free tier (optional, opt-in) | 5 k events/mo |

Everything above is swappable behind the ports in §7: D1 → Turso/Neon free,
Workers → Deno Deploy/Vercel free, without touching client code.

---

## 3. Topology, and the one thing that decides it

```
                 ┌──────────────────────── same origin ────────────────────────┐
   browser ──────►  cst.<something>.workers.dev                                 │
                 │    /                → static assets (Vite build)            │
                 │    /api/*           → Worker script                          │
                 │    /s/<slug>        → Worker (share landing, cached)         │
                 └────────────┬───────────────────────┬──────────────────────────┘
                              │                       │
                        ┌─────▼─────┐          ┌──────▼───────┐
                        │  D1 (SQL) │          │ Overpass API │  (cached, §9.1)
                        │ users…    │          │  upstream    │
                        └───────────┘          └──────────────┘

   github.io/complete-street-tool  ──►  same bundle, VITE_API_BASE unset
                                        = local-only mode, no accounts
```

**Why the canonical host should move to the Worker: cookies.** A session
cookie set by `api.foo.workers.dev` and sent from a page on `github.io` is a
third-party cookie. Safari's ITP blocks it outright and Chrome's third-party
cookie restrictions make it unreliable — `SameSite=None` does not save you.
The options are:

- **(A) Recommended.** Serve the app *and* the API from one Worker origin.
  The session cookie is first-party: `HttpOnly; Secure; SameSite=Lax`, no
  token ever reachable by JavaScript, XSS cannot exfiltrate a session.
- **(B) Acceptable.** Keep GitHub Pages canonical and drop cookies: the
  Worker returns a short-lived (15 min) access token held **in memory** plus
  a rotating refresh token in `localStorage`, sent as `Authorization:
  Bearer`. Works everywhere, but a single XSS is now a stolen refresh token,
  and Konva/MapLibre/Overpass responses give you a nontrivial injection
  surface to defend.

Pick (A). GitHub Pages keeps its current job as the always-available,
account-free mirror (`deploy:pages` stays exactly as it is today) — which is
also a useful failure mode: if the Worker is over quota, the tool still runs.

---

## 4. Auth

### 4.1 Flow (Authorization Code + PKCE, confidential client in the Worker)

```
GET /api/auth/github/start?next=/app
  ├─ generate state (32B) + PKCE verifier; store hash in an HttpOnly
  │  __cst_oauth cookie (10 min TTL, SameSite=Lax) — no server-side state
  └─ 302 → github.com/login/oauth/authorize?...&code_challenge=...

GET /api/auth/github/callback?code&state
  ├─ verify state against cookie, clear cookie
  ├─ POST github.com/login/oauth/access_token   (client_secret = Worker secret)
  ├─ GET  api.github.com/user (+ /user/emails)  → { subject, email, verified, login, avatar }
  ├─ upsert identities → users                  (§4.3 linking rules)
  ├─ create session row; set  __cst_session = <id>.<hmac>   HttpOnly Secure SameSite=Lax, 30d
  └─ 302 → <next>
```

Google is identical against `accounts.google.com` / the OIDC userinfo
endpoint. Both provider tokens are **discarded immediately after the
userinfo call** — CST never stores a provider access token, so it can never
leak one, and it never needs `repo` or `drive` scopes. Scopes requested:
GitHub `read:user user:email`, Google `openid email profile`.

> **Rejected: GitHub device flow.** Attractive because it needs no client
> secret, but `github.com/login/device/code` and `/login/oauth/access_token`
> send no CORS headers, so a browser cannot call them — a device flow still
> needs a server relay. Given we have a Worker, the normal code+PKCE flow is
> both cheaper and better UX (no code to type).

### 4.2 Sessions

- Cookie value `<sessionId>.<HMAC-SHA256(sessionId, SESSION_HMAC_KEY)>`. The
  HMAC lets the Worker reject forged/garbage ids **without a D1 read**,
  which matters for the 5 M rows/day budget.
- D1 stores only `sha256(sessionId)`, so a database dump does not yield live
  sessions.
- 30-day sliding expiry, refreshed lazily (one write per session per day at
  most — see §11).
- `POST /api/auth/logout` revokes the row; `DELETE /api/me/sessions` revokes
  all (the "sign out everywhere" button).
- CSRF: `SameSite=Lax` plus a strict `Origin`/`Sec-Fetch-Site` check on every
  non-GET. No token plumbing needed.

### 4.3 Identity linking (get this right or it becomes an account-takeover)

- Key on `(provider, subject)` — **never** on email. Emails get reused and
  re-verified.
- If `(provider, subject)` is unknown but a *verified* email matches an
  existing user's *verified* email → link to that user.
- If either side is unverified → create a separate user. Offer explicit
  "link account" from settings (which requires being signed in to both).
- Deleting one identity from a multi-identity user is allowed; deleting the
  last one is `DELETE /api/me` (§12).

### 4.4 Anonymous mode

No account: everything in IndexedDB, `.cst.json` for portability, no share
links. On first sign-in the client offers "upload your N local designs" —
one explicit action, not a silent sync. Signing out keeps local copies and
clears only the session.

---

## 5. Data model (D1)

`server/migrations/0001_init.sql`:

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,          -- 'u_' + 22 base62 chars
  handle         TEXT UNIQUE NOT NULL,      -- display name, seeded from provider login
  email          TEXT,                      -- verified email, nullable
  created_at     INTEGER NOT NULL,          -- epoch ms
  last_seen_day  INTEGER NOT NULL,          -- epoch day; write-once-per-day (§11)
  used_bytes     INTEGER NOT NULL DEFAULT 0,
  quota_bytes    INTEGER NOT NULL DEFAULT 26214400,   -- 25 MB
  role           TEXT NOT NULL DEFAULT 'user'         -- 'user' | 'curator' | 'admin'
);

CREATE TABLE identities (
  provider       TEXT NOT NULL,             -- 'github' | 'google'
  subject        TEXT NOT NULL,             -- provider's stable user id
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE sessions (
  id_hash        TEXT PRIMARY KEY,          -- sha256(sessionId)
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE projects (
  id             TEXT PRIMARY KEY,          -- 'p_' + 22 base62 chars
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  place          TEXT,                      -- geocode label, e.g. 'Kothrud, Pune'
  origin_lat     REAL, origin_lon REAL,     -- the store's projection origin
  schema_ver     INTEGER NOT NULL,          -- .cst.json schema version
  version        INTEGER NOT NULL DEFAULT 1,-- optimistic-concurrency counter
  bytes          INTEGER NOT NULL DEFAULT 0,-- current blob size
  stats          TEXT,                      -- tiny JSON: {nodes,edges,lengthM,stage}
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER                    -- soft delete; purged after 30 days
);
CREATE INDEX projects_user ON projects(user_id, updated_at DESC);

CREATE TABLE project_versions (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  blob           BLOB NOT NULL,             -- gzip(.cst.json), compressed in the browser
  thumb          BLOB,                      -- gzip(plan SVG), <= 40 KB
  bytes          INTEGER NOT NULL,
  sha256         TEXT NOT NULL,             -- dedupe / integrity
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (project_id, version)
);

CREATE TABLE shares (
  slug           TEXT PRIMARY KEY,          -- 10 base62 chars (~59 bits, unguessable)
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,          -- frozen: a share never follows later edits
  mode           TEXT NOT NULL DEFAULT 'view',  -- 'view' | 'copy'
  listed         INTEGER NOT NULL DEFAULT 0,    -- gallery candidate (§8.2)
  created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  views          INTEGER NOT NULL DEFAULT 0     -- bumped at most hourly (§11)
);
CREATE INDEX shares_project ON shares(project_id);

CREATE TABLE osm_cache (                    -- §9.1
  key            TEXT PRIMARY KEY,          -- sha256(normalized Overpass QL)
  body           BLOB NOT NULL,             -- gzipped Overpass JSON
  bytes          INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  hits           INTEGER NOT NULL DEFAULT 0
);
```

### 5.1 The payload

Exactly the `.cst.json` already planned for file save/open — the file format
*is* the wire format, so file mode and cloud mode never diverge:

```jsonc
{ "schema": 1,
  "origin": { "lat": 18.507, "lon": 73.807 },
  "nodes": {…}, "edges": {…},
  "nextNodeNum": 42, "nextEdgeNum": 37,
  "junctionDesigns": {…},          // only touched ones, per ARCHITECTURE.md §2
  "elements": {…}, "nextElementNum": 12 }
```

Derived artifacts (ribbons, junction surfaces, wedges, markings) are **never
serialized** — that is the same "derived, not stored" rule the client already
enforces, and it is what keeps payloads at tens of kilobytes.

### 5.2 Versioning of the schema

`schema_ver` is stored per project. Migrations are **client-side pure
functions** (`migrate[1→2]`, `migrate[2→3]`) run on load, never in the
Worker. The Worker only refuses `schema_ver` greater than a configured max
(so an old cached client can't clobber a newer design silently).

### 5.3 Version retention

Keep the current version plus the **2 previous** (`DELETE … WHERE version <=
current - 3` after each write). Cheap "oops" recovery without unbounded
storage. Identical `sha256` → bump `updated_at` only, write no new row.

### 5.4 Storage math (the number that actually bounds this design)

| Item | Typical |
|---|---|
| 1 km network, sections + junctions + furniture, raw `.cst.json` | 150–400 KB |
| gzipped (browser `CompressionStream`) | 25–70 KB |
| plan-SVG thumbnail, gzipped | 10–40 KB |
| → per project, 3 versions retained | ≈ 150–250 KB |

500 MB free D1 database ÷ ~200 KB ≈ **2 500 projects**; with the 20-project
soft cap that is ~150–500 real users' full libraries. Beyond that, in
increasing order of cost: shard across the remaining 9 free databases
(5 GB/account total ≈ 25 000 projects), then move `blob`/`thumb` to R2
(needs a card), then Workers Paid. Hard stop that never moves: **2 MB max
D1 row** — reject uploads above ~1.5 MB gzipped with a clear message
("this design is unusually large; save it as a file").

---

## 6. API surface

All under `/api`, JSON in/out except design blobs, which are raw
`application/gzip` bodies with metadata in a header — deliberately **not**
multipart, because parsing multipart burns the 10 ms CPU budget.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/auth/{github,google}/start?next=` | – | 302 to provider |
| `GET /api/auth/{github,google}/callback` | – | sets session, 302 to `next` |
| `POST /api/auth/logout` | session | revokes one session |
| `GET /api/me` | session | `{id, handle, email, usedBytes, quotaBytes, projectCount}` |
| `PATCH /api/me` | session | rename handle only |
| `DELETE /api/me` | session + `X-Confirm: <handle>` | cascade purge (§12) |
| `GET /api/projects` | session | metadata list, no blobs; `?updatedSince=` for delta sync |
| `POST /api/projects` | session | `{title, place, origin, schemaVer, stats}` → `{id, version:0}` |
| `PUT /api/projects/:id` | session, owner | body = gzip blob; `X-CST-Meta` = small JSON; `If-Match: <version>` → `{version}` or **409** |
| `GET /api/projects/:id` | session, owner *(or share)* | gzip blob + `X-CST-Meta`, `ETag: "<version>"` |
| `DELETE /api/projects/:id` | session, owner | soft delete |
| `POST /api/projects/:id/restore` | session, owner | undo soft delete within 30 days |
| `GET /api/projects/:id/versions` | session, owner | `[{version, bytes, createdAt}]` |
| `GET /api/projects/:id/versions/:n` | session, owner | historical blob |
| `POST /api/projects/:id/shares` | session, owner | `{mode, listed, expiresAt}` → `{slug}`; Turnstile if `listed` |
| `GET /api/shares/:slug` | – | frozen blob, `Cache-Control: public, max-age=300` |
| `DELETE /api/shares/:slug` | session, owner | revoke |
| `POST /api/shares/:slug/fork` | session | copy into caller's account (`mode='copy'` only) |
| `GET /api/gallery` | – | curated list (§8.2), heavily cached |
| `GET /api/osm?bbox=&preset=` | – (rate-limited) | cached Overpass passthrough (§9.1) |
| `GET /api/health` | – | version, migration state |

Errors are `{error: {code, message}}` with stable codes: `unauthenticated`,
`forbidden`, `not_found`, `version_conflict`, `quota_exceeded`,
`payload_too_large`, `rate_limited`, `schema_too_new`, `upstream_unavailable`.
The client maps codes → UI copy; it never parses messages.

---

## 7. Client integration

### 7.1 One port, three adapters

```ts
// app/src/persistence/types.ts
export interface ProjectMeta {
  id: string; title: string; place?: string; version: number;
  updatedAt: number; bytes: number; origin?: { lat: number; lon: number };
}

export interface DesignStore {
  list(): Promise<ProjectMeta[]>;
  load(id: string): Promise<{ meta: ProjectMeta; design: DesignFile }>;
  save(meta: ProjectMeta, design: DesignFile): Promise<ProjectMeta>;  // throws VersionConflict
  remove(id: string): Promise<void>;
}
```

- `localStore` — IndexedDB, always present, always written **first**.
- `cloudStore` — the API above; only constructed when `VITE_API_BASE` is set
  *and* `/api/me` returns a user.
- `fileStore` — File System Access API (Chromium) with a
  download/upload fallback; this is the one that works forever, offline, on
  any fork.

`store.ts` gains **no** persistence logic. A thin `usePersistence` hook owns
serialize/deserialize (the undoable slice only, per `ARCHITECTURE.md` §7) and
the sync state machine. Serialization must read exactly the `partialize`
key set — if those drift, saves silently lose data, so they should be
derived from one shared constant.

### 7.2 Sync state machine

```
 idle ──(store change)──► dirty ──(debounce 5 s)──► localStore.save ──► synced-local
 synced-local ──(explicit Save | 60 s idle | visibilitychange hidden)──► pushing
 pushing ──ok──► clean       pushing ──409──► conflict      pushing ──offline──► outbox
 outbox ──(online + focus)──► pushing
```

Rules that keep us inside the free tier (§11): **IndexedDB absorbs
autosave; the network sees one push per meaningful edit burst.** Never push
per keystroke or per drag. `navigator.sendBeacon` on unload is *not* used
(no `If-Match` semantics) — the 60 s idle push plus the `visibilitychange`
push covers it.

### 7.3 Conflicts

Optimistic concurrency on `projects.version`. On 409 the client does **not**
merge (no CRDT, no three-way merge of a geometry graph — both would be
wrong). It saves the local state as a sibling project
`"<title> (conflict 18 Aug 14:22)"` and shows a two-panel chooser with each
side's `{nodes, edges, elements}` counts and thumbnails. Boring, honest,
~40 lines.

### 7.4 Offline

The app is already a static bundle; add a minimal service worker that
precaches the build and serves it offline. Basemap tiles are **not**
precached (OSM tile policy, and size). Overpass import obviously requires
network — surface that as a disabled tool with a reason, not a failed fetch.

---

## 8. Sharing & publishing

### 8.1 Share links

`https://<host>/s/<slug>` → the same SPA in read-only mode, which fetches
`GET /api/shares/:slug`. Properties worth keeping:

- **Frozen to a version.** Sharing a design does not publish your later
  edits. Users assume this; violating it is a privacy bug.
- **Unguessable slug, not "public".** 10 base62 chars ≈ 59 bits.
- `mode: 'copy'` adds "Open a copy" → `POST /api/shares/:slug/fork`, which
  is how studio instructors distribute a starting network. This is the
  cheapest high-value feature in the whole document.
- Optional `expires_at`; revocable; view counter bumped at most hourly.

### 8.2 Gallery, and how to moderate it for free

Anything publicly listed needs moderation, and moderation is the one cost
that is *not* free. Cheapest credible version: `listed = 1` only marks a
share as a **candidate**; the actual gallery is a JSON file in this repo
(`gallery.json`, list of slugs + captions), so publishing is a pull request
and moderation is `git revert`. No admin UI, no queue, no takedown tooling,
and the audit trail is git history. `GET /api/gallery` just serves that file
with a long cache TTL. If the gallery ever outgrows PR-based curation, that
is the moment to add a `curator` role (already in the schema) — not before.

---

## 9. Ancillary services

### 9.1 Overpass cache/proxy — worth doing, with care

Today the client hits a public Overpass instance directly. A cached
passthrough is better for everyone: identical bbox queries from a classroom
of 40 students hit the upstream once, and the app stops being a
rate-limit-hostile client.

- Normalize the query (round bbox to ~1e-4°, sort filters) → `sha256` key.
- Serve from `osm_cache` if `created_at` < 7 days; else one upstream fetch
  (exactly 1 of the 50 allowed subrequests), stream the body straight to
  D1/response **without parsing** (CPU budget).
- Send a real `User-Agent` with the project URL, per Overpass etiquette.
- Per-IP rate limit (§11); on upstream 429/504 return `upstream_unavailable`
  and let the client fall back to calling Overpass directly — so the proxy
  is an optimization, never a single point of failure.
- Cap `osm_cache` at ~100 MB with LRU eviction by `hits`/`created_at`.

Note: `Cache-Control` response headers do useful work here regardless of
whether the Workers Cache API is active on a `*.workers.dev` host (its
behaviour there has changed over time — verify before relying on it; the
D1-backed cache above does not depend on it).

### 9.2 Basemap tiles — a separate problem, flagged not solved

Currently raster OSM tiles straight from `tile.openstreetmap.org`. That is
fine for development and thin usage but **the OSM Tile Usage Policy does not
permit it for an app with real traffic**, and it is not a backend problem you
can proxy away (proxying makes it worse: one IP, heavy load). Free paths, in
order of preference:

1. **Protomaps PMTiles** — a single-file vector basemap served over HTTP
   range requests, styled client-side. Truly key-less and self-hostable, but
   the file wants object storage (R2 → card) and a Worker range-request
   shim.
2. A **free tier with a domain-restricted key** (MapTiler / Stadia / Carto).
   Key is public in the client; restrict by referrer. Costs nothing at our
   scale, but adds a vendor and an account.
3. Stay on raster OSM, with attribution, and revisit when analytics show
   real volume.

Recommendation: (3) now, (1) when someone is willing to attach a card, and
keep the basemap behind the existing provider switch in `Basemap.tsx` so
this stays a one-file change.

### 9.3 Analytics, errors, feedback

- **Analytics:** Cloudflare Web Analytics or GoatCounter — cookieless, no
  consent banner needed, free. Track page/stage transitions only; never
  design content.
- **Errors:** Sentry free tier, opt-in via a settings toggle, with
  `beforeSend` stripping the design payload (it will otherwise walk into
  breadcrumbs).
- **Feedback:** a "report a problem" link that opens a prefilled GitHub
  issue. Zero infra, and the report lands where the fix happens.

---

## 10. Ops

### 10.1 Layout

```
/server
  wrangler.toml          # one Worker, one D1 binding, assets = ../app/dist
  src/index.ts           # router (hand-rolled or itty-router, ~100 lines)
  src/auth/{oauth,session,linking}.ts
  src/routes/{projects,shares,osm,me}.ts
  src/db/{queries,quota}.ts
  migrations/0001_init.sql …
  test/                  # vitest + @cloudflare/vitest-pool-workers (real D1)
```

The Worker is the only place secrets exist: `GITHUB_CLIENT_ID/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`, `SESSION_HMAC_KEY`, optional
`TURNSTILE_SECRET` — five values, set with `wrangler secret put`, never in
the repo, never in the client bundle.

### 10.2 CI/CD (GitHub Actions, free on public repos)

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PR, push | `tsc -b`, `oxlint`, Worker unit tests, `vite build` |
| `deploy-worker.yml` | push to `main` touching `server/**` or `app/**` | `wrangler d1 migrations apply --remote` then `wrangler deploy` |
| `deploy-pages.yml` | push to `main` touching `app/**` | existing `deploy:pages` (mirror stays alive) |
| `backup.yml` | cron nightly | `wrangler d1 export --remote` → gzip → upload artifact (90 d) |
| `purge.yml` | cron daily | purge `deleted_at < now-30d`, expired shares/sessions, LRU-trim `osm_cache` |

One secret in GitHub: `CLOUDFLARE_API_TOKEN`, scoped to Workers Scripts +
D1 edit on one account. Migrations are forward-only and additive; deploy
order is always *migrate, then deploy* so the new schema is present before
the new code.

### 10.3 Recovery

Three independent layers: D1 Time Travel (point-in-time restore; confirm the
retention window for the free plan), the nightly export artifact, and — the
one that actually matters — **every user still has a `.cst.json` they can
open with the API switched off**. Test the restore path once, from the
artifact into a fresh D1 database, and write down the commands.

---

## 11. Free-tier caps → product rules

The whole design is downstream of this table. Each cap becomes a rule in
code, not a runtime surprise.

| Cap (free) | Binding rule |
|---|---|
| 100 000 Worker req/day | ~12 requests per editing session (auth check, list, load, 3–6 pushes, share) ⇒ ≈ **8 000 sessions/day** headroom. Static assets don't count. |
| 100 000 D1 rows written/day | No cloud autosave. Push on explicit save / 60 s idle / tab hide. `last_seen_day` written once per user per day. Share views bumped ≤ hourly. ⇒ ~6 writes per save. |
| 5 M D1 rows read/day | Every read path is indexed and single-row or bounded; session cookies are HMAC-prechecked to avoid junk reads; public share reads carry `Cache-Control`. |
| 500 MB per D1 database | 20 projects and 25 MB per user (soft, shown in the UI); 3 versions retained; 30-day purge of soft-deleted rows. |
| 2 MB max D1 row | Reject blobs > 1.5 MB gzipped with `payload_too_large` and a "save as file" path. |
| 10 ms CPU per request | Never parse, validate, or compress design JSON server-side. No PDF/DXF/SVG generation on the server, ever. |
| 50 subrequests per request | The Overpass proxy makes exactly one. |
| 10 D1 databases / 5 GB per account | The shard-by-user-id escape hatch, if it is ever needed. |

**Abuse controls** (all free): per-IP token bucket in D1 or a Durable
Object (60 writes/hour, 10 Overpass calls/hour, 5 signups/day), Turnstile
on public listing, `Origin` checks on writes, hard byte cap per request, and
a kill switch env var that puts the API in read-only mode. Quota UI copy
should say what the limit is and that the local/file path is unlimited —
"free tool, real limits, your data is still yours" is a fine message.

---

## 12. Privacy & legal (Indian audience ⇒ DPDP Act 2023)

- **Collected:** provider subject id, verified email, display handle,
  timestamps, project blobs the user chose to save. Cloudflare's own request
  logs see IPs; keep no IP column of our own.
- **Not collected:** passwords, provider tokens, contacts, location beyond
  the design's own projection origin, third-party trackers, ad cookies.
- **Purpose limitation:** the email is used for account identity only. No
  marketing (there is no mailing list, which is also why there is no email
  provider in the stack).
- **Consent notice** at the sign-in button, not buried in a footer: one
  sentence saying what is stored and that designs are private until shared.
- **Rights:** `GET /api/me/export` (all metadata + blobs as one zip,
  assembled client-side from existing endpoints) and `DELETE /api/me`
  (immediate cascade delete of users/identities/sessions/projects/versions/
  shares; backups age out within 30 days — say so in the privacy note).
- **Public shares are public:** warn once, at share creation, that the
  design and its place name become visible to anyone with the link.
- **Repo docs:** `PRIVACY.md` and `TERMS.md` at root, short and readable,
  plus "this tool produces concept designs, not construction documents" —
  the same disclaimer the plan already puts on IRC rule provenance.

---

## 13. Build order (each slice ships standalone)

**B0 — Local persistence, zero infrastructure.** `DesignStore` port,
`localStore` (IndexedDB autosave + recovery on reload), `fileStore`
(`.cst.json` open/save with schema version), project switcher UI,
`migrate[]` scaffold.
*Done when:* draw a network, reload the tab, get it back; save a file, open
it in another browser, identical geometry; corrupt/old-schema file gives a
clear error rather than a broken canvas.

**B1 — Worker + D1 + OAuth + cloud projects.** Migrations, GitHub sign-in,
sessions, `/api/me`, project CRUD with `If-Match`, quotas, `cloudStore`,
sync state machine, conflict chooser.
*Done when:* sign in on two browsers, edit in one, the other sees the change
after reload; a forced concurrent edit produces a conflict copy and loses
nothing; signing out leaves local copies intact; `VITE_API_BASE` unset still
builds and runs the whole app.

**B2 — Sharing.** Share slugs, read-only viewer mode, `mode:'copy'` fork,
revoke/expiry, `gallery.json` + `/api/gallery`.
*Done when:* a logged-out browser opens a share link and sees the plan;
revoking returns 404; forking lands an independent editable copy; later
edits to the original do not change the shared version.

**B3 — Hardening & polish.** Google sign-in, Overpass cache, rate limits,
Turnstile on listing, backup/purge crons, `PRIVACY.md`/`TERMS.md`, export
and delete-account endpoints, service worker.
*Done when:* the backup artifact restores into a fresh D1; rate limits
return `rate_limited` under a scripted flood; delete-account leaves zero
rows across all tables.

Suggested order relative to app work: B0 immediately (it is the most-asked-
for feature in any design tool and needs no accounts), B1 once the `.cst.json`
schema has stopped moving, B2 whenever the tool is first shown to a class or
posted publicly, B3 before any real publicity.

---

## 14. When to spend money, and how much

| Trigger | Action | Cost |
|---|---|---|
| > ~8 000 sessions/day, or 429s appear | Workers Paid | $5/mo (includes 10 M req, 30 s CPU, 5 GB D1/db) |
| D1 database > ~400 MB | Shard across free databases, then move blobs to R2 | $0, then card required |
| Basemap volume becomes impolite | Protomaps PMTiles on R2 | ~$0 within R2 free tier (card) |
| Nicer URL + edge caching + email-free custom domain | Buy a domain | ~₹900/yr |

Everything stays portable at each step: D1 is SQLite (`wrangler d1 export`),
auth is standard OAuth with no vendor session format, designs are files, and
the client keeps working with the API turned off entirely.

---

## 15. Rejected alternatives

| Option | Why not |
|---|---|
| **Supabase** (Auth+Postgres+RLS) | Free projects pause after 7 days idle — an academic tool has idle weeks; also 2-project limit and per-MAU ceiling. Least-code option if you accept a wake-up delay and a Pro upgrade later. |
| **Firebase** (Auth+Firestore) | Generous, but per-MAU auth pricing above the free band, Google Cloud billing account pressure, and a document model that adds nothing over "one opaque blob per project". |
| **Vercel/Netlify + Neon/Turso** | Works and is free, but splits hosting/DB/auth across three vendors and three dashboards; cold starts and per-project free-tier changes are outside our control. |
| **Cloudflare Pages Functions** | Same runtime as Workers, but Workers static assets is now the maintained path and gives one deployment unit. |
| **GitHub as the storage backend** (designs in a Gist or the user's repo) | Genuinely $0 storage and lovely for privacy, but: needs a token exchange server anyway (device flow has no CORS), a GitHub account becomes mandatory for cloud save — a hard barrier for the student/practitioner audience — and every save is a Git commit. Keep as a *future opt-in* "bring your own storage" adapter behind the same `DesignStore` port. |
| **Self-hosted VPS (Oracle/Fly free tiers)** | Free tiers here are reclaimable and require patching, monitoring, backups, TLS — real operational cost paid in maintainer time. |
| **Own password auth** | Password hashing, reset emails (needs an email vendor), breach liability. All avoidable, so avoid it. |
| **Real-time multiplayer (Durable Objects + Yjs)** | Free at our scale, but incompatible with the single linear undo history and derived-state model (§0.5). Revisit only as a deliberate rewrite. |

---

## 16. Decisions needed from you

1. **Canonical host:** move to the Worker origin (recommended — first-party
   cookies, §3A), or stay on GitHub Pages with bearer tokens (§3B)?
2. **Providers:** GitHub only (simplest, but many target users have no
   GitHub account), or GitHub + Google from the start?
3. **Public gallery in B2, or private share links only?** The gallery is the
   only part of this design with an ongoing human cost (moderation).
4. **Overpass proxy now or later?** It helps the upstream and classroom
   usage but adds the first piece of server state that isn't user data.
5. **Willing to attach a card to Cloudflare (never charged within limits)?**
   If yes, R2 unlocks Protomaps basemaps and unbounded blob storage. If no,
   the design above stands as written.

---

## 17. Sources for the free-tier numbers (verified 18 Aug 2026)

- Workers limits & pricing — https://developers.cloudflare.com/workers/platform/limits/
- Workers static assets billing — https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- D1 limits — https://developers.cloudflare.com/d1/platform/limits/
- Supabase pricing / free-tier pausing — https://supabase.com/pricing
- GitHub OAuth app best practices (secrets, device flow) — https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app
- GitHub Pages limits — https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- OSM Tile Usage Policy — https://operations.osmfoundation.org/policies/tiles/

Re-check these before committing to the caps in §11; free tiers move.
