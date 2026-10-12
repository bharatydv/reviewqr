# ReviewQR

A customer scans the QR code on your counter, reads your latest reviews, verifies their email
once, and leaves **one** review. They pick a star rating and tap a few topics; the app drafts 5–7
reviews from exactly those details, and they choose one, edit it and post it.

No build step, no native dependencies, no tracking. Node, SQLite and three npm packages.

- **Customer page:** `/b/:slug`
- **Owner console:** `/admin` — an email and a password each
- **QR codes:** `/api/b/:slug/qr.png` and `.svg`

## Requirements

- Node.js **22.13 or newer** (the app uses the built-in `node:sqlite` module, so there is nothing
  to compile)
- An SMTP account — only if you switch on email verification for a business. Not needed otherwise.
- Optionally an Anthropic API key, for AI-written drafts. Without one the app falls back to
  template drafts and everything still works.

## Setup

```bash
git clone <your-fork> reviewqr && cd reviewqr
npm install
cp .env.example .env     # then edit it: ADMIN_TOKEN at the very least
npm start
```

Open http://localhost:3000. A demo business, **Blue Door Café**, is seeded with four reviews, one of them answered:

- profile: http://localhost:3000/b/blue-door-cafe
- console: http://localhost:3000/admin — create an account there

The first account created runs the server: it is the platform admin, and it adopts every business
that has no owner yet, so the seeded demo is waiting for you rather than an empty list. Accounts
created after it are ordinary owners who see only their own businesses. See
[Accounts](#accounts).

In development, if `SMTP_HOST` is empty the login code is printed to the server console instead of
being emailed:

```
  ReviewQR login code for you@example.com: 418203  (expires in 10 minutes)
```

So you can walk the entire customer flow locally with no mail server.

```bash
npm run dev    # same thing, with --watch
npm test       # 95 tests, in-memory database, the AI call and Google mocked
```

The app refuses to start with an unusable configuration (no `ADMIN_TOKEN`; in production: a
non-https `BASE_URL`, or the example admin token still in place).

## How the flow works

**1. Scan.** The QR code encodes `BASE_URL + /b/:slug`. The page shows the name, category,
address, average rating, a 5-to-1 star breakdown and the latest `MAX_VISIBLE_REVIEWS` reviews
(default 6, allowed 3–6). Each review shows a first name, stars, a date and the text — never an
email address.

**2. Nothing is asked of them.** No email, no name, no account, no code. The browser that scanned
the code is given a long-lived `rq_device` cookie on arrival, and the hash of that cookie *is* the
reviewer's identity. That is what enforces one review per business, and it is why the customer
goes straight from scanning to the stars.

The reviewer row is only created when they actually write something, so a bot that loads the page
leaves nothing behind. Reviews with no name attached are shown as "A customer".

This is a deliberate trade. A device cookie is weaker than a verified email: clearing cookies, or
using a second phone, buys another review. In exchange, the single biggest drop-off in the funnel
disappears — switching to a mail app and back loses most people. Per-IP limits and moderation are
what hold the line instead, and if the review's real destination is Google (step 6), Google's own
account check is the identity that actually matters.

**Sign in with Google, when it is configured.** Set `GOOGLE_CLIENT_ID` and the page loads Google
One Tap: a customer already signed in to Google on their phone sees a prompt naming their account,
and one tap identifies them. No typing, no code, no email — and unlike a device cookie, a Google
account is one person across every device they own, which is what makes "one review per person"
mean something again. They can dismiss it and review anonymously; nothing is lost either way.

A review they left seconds earlier as an anonymous device is carried into the account rather than
orphaned, and it picks up their first name.

> This identifies the customer **on your site**. It grants no ability to post on Google — no
> OAuth scope exists for that. See "Posting on Google" below.

**Businesses that want verified reviewers can still have them.** Tick "Ask reviewers to verify an
email first" in the admin console and that business gets the email flow: email plus first name, a
6-digit code generated with `crypto.randomInt`, stored only as a keyed hash, expiring in 10
minutes, 5 attempts, single use, then a 30-day session. It is off by default, and SMTP is only
needed if some business turns it on.

### Setting up Google One Tap

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and
   configure the OAuth consent screen (External; the default scopes are enough — you are only
   reading the signed-in identity).
2. Credentials → Create credentials → **OAuth client ID** → **Web application**.
3. Under **Authorized JavaScript origins**, add your `BASE_URL` exactly, scheme and port included.
4. Copy the client id into `GOOGLE_CLIENT_ID`.

**One Tap only runs on `https://` origins, or on `http://localhost`.** A LAN address like
`http://192.168.1.10:3000` will not work — Google refuses to serve the prompt there, and the page
quietly falls back to anonymous reviewing. To try it on a phone before you deploy, put the app
behind an https tunnel and use that hostname as both `BASE_URL` and the authorized origin.

The ID token is verified in `lib/google.js` against Google's published signing keys, checking the
RS256 signature, the issuer, the audience and the expiry, with the keys cached for as long as
Google's `Cache-Control` says. A token signed by anyone else, issued for another site, unsigned,
or expired is refused — there are tests for each of those.

**3. Quick input.** A required star rating, optional topic chips and an optional one-line note,
"Anything specific?" (200 characters). **Tapping a star is enough** — the drafts are fetched on
their own, so the customer goes from stars straight to choosing words. Topics and the note refine
the next set, which is what "Regenerate" is for.

The automatic fetch is debounced by 700ms and happens only while there are no drafts on screen. A
finger sliding from one star to five fires a change event per star, and each one would otherwise be
an AI call and one of the ten suggestions an hour the device is allowed; and once drafts exist, a
changed rating must not silently replace words somebody is already editing.

The chips are **per business**, set in the admin console, because the right prompts depend on the
trade: a café wants Service, Food, Price, Cleanliness, Staff, Atmosphere (the default six), while
a software company wants something like Service, Communication, Delivery time, Expertise, Value.
Up to 8 chips, 24 characters each. The server only accepts a topic that the business actually
offers, so a chosen topic is always a label the customer was really shown.

**4. Drafts.** `POST /api/suggest` returns 5–7 drafts that differ in length (short, medium,
longer) and tone (casual, warm, professional). The selected draft opens in an editable textarea
with a live character counter (20–400). "Regenerate" asks for a new set.

**Picking a draft hands the customer to Google straight away,** where a Google review link is set:
the words go on the clipboard and Google's review box opens in its own tab, so the remaining
gestures are paste, stars, Post. The tab is opened inside the tap that selected the draft, so it is
a user gesture rather than a popup; a browser that refuses anyway leaves the button on the page.
It opens once per visit, not once per draft — somebody comparing two drafts would otherwise collect
a tab each, and their Google tab is already waiting for a paste. Selecting a different draft
re-copies without opening anything. With no Google link set, none of this appears and picking a
draft just fills the textarea.

**5. Post.** One review per person per business, enforced by a `UNIQUE (business_id, user_id)`
index — a second attempt returns 409. The new review appears at the top of the list. Coming back
to the page later shows their own review with Edit and Delete instead of the form.

**6. Post it on Google too (optional).** The same offer again, after posting here: "Copy and open
Google" puts their words on the clipboard and opens Google's review box in a new tab, where they
paste, pick their stars and post. Step 4 is the main hand-off; this one catches anyone who posted
here first, or whose tab was blocked, or who closed it. The offer stays available later from their
own review on the page. With no link set, the step is hidden entirely and nothing changes.

The control is a real link, so the browser treats it as an ordinary navigation and no popup
blocker interferes. The clipboard API needs a secure context, so over plain `http` on a local
network it falls back to a hidden textarea, and then to simply asking the customer to copy the
text shown above the button.

> **Do not gate this by rating.** Google's policy forbids asking only happy customers for public
> reviews, so the Google step is offered after *every* review, 1 star or 5. If you want a private
> channel for unhappy customers, add it for everyone, not as a diversion for low ratings.

If the customer leaves to check their email mid-way, their rating, topics, note and draft are
restored from `sessionStorage` when they come back.

**7. The business answers (optional).** Every review in the admin console has a **Reply** button.
The reply is public: it appears indented under that review on the business page, under the
business's own name and the date it was written, and the reviewer sees it on their own review when
they come back. Replies can be rewritten or taken down at any time, and there is nothing to
configure — a business that never replies simply has none.

Up to 600 characters, cleaned and whitespace-collapsed like every other stored string, and
rendered with `textContent` on the client. A reply says nothing about who wrote the review it
answers, so it adds nothing identifying to the public response.

**Editing a review clears the reply.** The answer was written about particular words, and leaving
it under rewritten ones would misrepresent the business — a 1-star review edited after a warm
reply is the case that matters. So a change to the rating or the text drops the reply and the
business can answer afresh; the edit form says so before the customer saves. Saving identical
text back is not a change and keeps the reply.

### What each business switches on for itself

The three optional integrations are configured once on the server, with a key or a password, and
then switched on or off **per business** in the admin console. A key is what makes a feature
possible; the switch is what makes a particular business use it.

| In the admin console | Default | Off means |
| --- | --- | --- |
| Offer AI-written drafts | on | That business's customers get template drafts, and the model is never called for them. |
| Offer Google sign-in | on | That business's page is never given the client id, so no prompt appears. |
| Ask reviewers to verify an email first | off | Nothing is asked of that business's customers; the device cookie is the identity. |
| Google review link | empty | The "post it on Google too" step is hidden entirely for that business. |

Both of the first two are on by default, so an existing install behaves exactly as it did before
and a new business inherits whatever the server is configured for. Switching one off takes effect
on the next request: no restart, no key change, nothing to redeploy. That is what makes it usable
for a group of venues on one server - one café paying for AI drafts, another on templates, a third
insisting on verified email - and it is also the cost control, since a business with drafts off
costs nothing per scan.

Topic chips are per business in the same way, and so is the Google review link.

### What the AI is told, and what it is not

The suggestion prompt contains only five things: the star rating, the chosen topics, the optional
note, and the business name and category. The customer's email, name, IP address and user id are
never sent to the model — there is a test that asserts this against the recorded request body.

The system prompt forbids inventing dishes, staff names, prices, dates or events, requires the
sentiment to match the stars (1–2 critical but civil, 3 mixed, 4–5 positive), bans emojis,
hashtags and any mention of AI, and asks for nothing but a JSON array of strings.

Every reply is then re-checked on the server: trimmed, whitespace-collapsed, deduplicated, and
anything outside 20–400 characters or containing an emoji or hashtag is dropped. If fewer than
five usable drafts remain, the set is topped up with template drafts built from the same rating
and topics. If the API key is missing, the call fails, times out (15s) or is declined, the
customer gets template drafts and never sees an error.

Two deliberate choices in `lib/ai.js`, both documented in the code:

- The Messages API is called with plain `fetch` rather than `@anthropic-ai/sdk`, because this
  project ships only three dependencies on purpose.
- The request sets `output_config: {effort: "low"}`. Writing six short drafts is a simple task and
  the whole call has a 15-second budget, so shallow reasoning keeps it comfortably inside that.
- Server-side refusal fallbacks are *not* enabled. The app already has a local fallback that is
  instant and free, so a decline goes straight to template drafts.

`ANTHROPIC_MODEL` defaults to `claude-opus-5-5`. If you would rather trade a little quality for a
much cheaper and faster call, `claude-haiku-5-5` suits this workload well — it is a one-line
change in `.env`.

## Accounts

The console at `/admin` belongs to owner accounts. They are a separate identity from reviewers:
an owner has an email and a password, a reviewer is a device cookie that left a review, and
nothing in the schema lets one be mistaken for the other.

- **The first account to sign up runs the server.** It becomes the platform admin and adopts every
  business that has no owner — on an existing install that is all of them, on a fresh one the
  seeded demo. Somebody has to be in charge, and on an empty install there is nobody to grant it.
- **Everyone after that is an ordinary owner.** They see the businesses they created and nothing
  else. Another owner's business answers `404`, not `403`: a `403` would confirm the id exists,
  which is how you count somebody else's customers.
- **Reviewers are shared, so the People tab is the platform admin's.** Who has signed in and who is
  suspended spans every business on the server, so it is not an ordinary owner's to see.
- **Passwords** are scrypt (`N=16384, r=8, p=1`) from `node:crypto`, so there is still nothing to
  compile. At least 10 characters; length is the rule that does the work. Hashing is async on
  purpose — at those parameters it costs ~100ms of CPU, and `scryptSync` would stall the single
  thread for that long on every sign-in, reviewers included.
- **Wrong password and unknown account are refused in the same words,** and the hash is computed
  either way, so neither the wording nor the timing says which it was.
- **A forgotten password needs SMTP:** a 6-digit code, 30 minutes, 5 attempts, single use. Asking
  for one answers the same whether or not the address has an account. With no `SMTP_HOST` the
  console does not offer the link and the endpoint says so, rather than sending to a log nobody
  reads. Using a code ends every session, including one an attacker is holding; changing a password
  from the **Account** tab ends every session but the browser doing it.
- **`ADMIN_TOKEN` still works** as the `x-admin-token` header, needs no account and sees
  everything. It is the API path — the `curl` examples below use it — and the rescue path, since it
  works before the first account exists. It is not a browser sign-in: the console has no field for
  it any more. A business created with the token has no owner, so only a platform admin sees it.

## Security

- `user_id` comes only from the cookies, never from a request body. A `user_id` in a body is
  ignored, and there is a test that proves it.
- Device identity: a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in
  production), remembered for 400 days. Only its SHA-256 hash is stored. Being `HttpOnly`, page
  scripts cannot read or forge it.
- Sessions, for businesses that require an email: a random 32-byte token in an `HttpOnly`,
  `SameSite=Lax` cookie; only its SHA-256 hash is stored; 30-day expiry.
- Owner sessions, for the console: the same shape, in its own `rq_owner` cookie and its own table,
  so signing out of the console never signs you out of a review you left in the same browser, or
  the other way round. A suspended owner keeps the cookie and gets nothing with it.
- CSRF: a double-submit token. Every `POST`, `PUT`, `PATCH` and `DELETE` must echo the `rq_csrf`
  cookie in an `x-csrf-token` header, and once signed in as a reviewer the token must also match
  the one stored on the session. The token is rotated at sign-in and sign-out. Console routes are
  double-submit only, not pinned to the reviewer session: an owner may have left a review in this
  browser too, and that session's token goes stale the moment signing in rotates the cookie, which
  would lock them out of their own console. The `x-admin-token` path carries no CSRF check and
  needs none — a cross-site form cannot set a custom header, so holding the token is itself proof
  the request was deliberate, and the route stays usable from `curl`.
- Rate limits, in a SQLite table so they survive a restart: suggestions 10 per hour per device and
  30 per hour per IP, reviews 3 **successful** posts per hour per device and 10 per hour per IP,
  login endpoints 10 per 15 minutes per IP (reviewer and owner sign-in, signup, forgot and reset
  all count against it), code requests 5 per hour per email *and* per IP, admin
  100 per 15 minutes per IP. The per-IP figures matter more than they used to: a device is cheap
  to reset by clearing cookies, so the address is the backstop. Set `TRUST_PROXY=1` behind a proxy
  or they all collapse onto the proxy's IP.
- A code request returns the same response whether the address is unknown, known, suspended or
  rate limited.
- All secrets are compared in constant time. Login code hashes are HMACs keyed with a pepper
  derived from `ADMIN_TOKEN` and bound to the email address, because a bare hash of six digits
  would be trivial to reverse.
- Every input is validated and sanitised on the server; all user text is rendered with
  `textContent`; the JSON body limit is 10kb.
- Security headers on every response: CSP (no `unsafe-inline`), `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and HSTS in production.
- Public API responses contain a first name and nothing else identifying. Suspended users cannot
  sign in or post, and suspending someone ends their sessions.
- Forms carry a hidden honeypot field; a filled one is dropped silently.

**Rotating `ADMIN_TOKEN` invalidates any login codes that are in flight** (it is the pepper), so
rotate it when nobody is mid-sign-in. Sessions and reviews are unaffected.

## Accessibility

Every field has a real label. The star rating is a keyboard-operable radio group with
`aria-label`s ("4 stars, good"); topics are checkboxes; drafts are a radio group of cards. Touch
targets are at least 44px, focus is always visible, loading and error messages live in
`aria-live` regions, animation respects `prefers-reduced-motion`, and text contrast is at least
4.5:1 (stars, as a non-text element, are above 3:1). Empty, loading and error states all say what
happened in plain language.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `BASE_URL` | `http://localhost:3000` | What the QR codes encode. Must be `https://` in production. |
| `ADMIN_TOKEN` | — | **Required.** The API and rescue token for the console (`x-admin-token`), and the pepper for login-code hashes. Owners sign in with their own passwords instead. At least 16 characters in production. |
| `DB_PATH` | `./data/reviewqr.db` | `:memory:` gives a throwaway database. Parent directories are created. |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy, so rate limits see the real client IP. |
| `MAX_VISIBLE_REVIEWS` | `6` | Clamped to 3–6. |
| `SMTP_HOST` | — | Only needed by a business with email verification switched on. Empty in development prints codes to the console. |
| `SMTP_PORT` | `587` | Port 465 switches on implicit TLS. |
| `SMTP_USER` / `SMTP_PASS` | — | Omit both for an unauthenticated relay. |
| `MAIL_FROM` | `ReviewQR <no-reply@example.com>` | Required when SMTP is configured. |
| `GOOGLE_CLIENT_ID` | — | Web OAuth client id. Empty means no Google prompt and no sign-in at all. https origins only. Can be switched off per business. |
| `ANTHROPIC_API_KEY` | — | Without it, template drafts are used. Can be switched off per business. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | |

Real environment variables always win over `.env`. `NODE_ENV=production` turns on the stricter
checks, `Secure` cookies and HSTS.

## API

Public (no sign-in needed; the device cookie is the identity):

```
GET  /api/b/:slug
GET  /api/b/:slug/qr.png        ?download=1
GET  /api/b/:slug/qr.svg        ?download=1
POST /api/auth/google           {credential}   Google One Tap ID token
POST /api/auth/request-code     {email, firstName}
POST /api/auth/verify-code      {email, code}
POST /api/auth/logout
GET  /api/auth/me
```

Reviewing (device cookie + `x-csrf-token`; an email session only where the business requires it):

```
POST   /api/suggest             {slug, rating, topics[], note}
POST   /api/b/:slug/reviews     {rating, comment}
PUT    /api/b/:slug/reviews/me  {rating, comment}
DELETE /api/b/:slug/reviews/me
```

The console's own account (cookies + `x-csrf-token`; no sign-in needed to reach them):

```
GET  /api/owner/me                       who is signed in, and whether setup is still needed
POST /api/owner/signup          {email, name, password}
POST /api/owner/login           {email, password}
POST /api/owner/logout
POST /api/owner/password        {currentPassword, newPassword}
POST /api/owner/forgot          {email}            emails a 6-digit code
POST /api/owner/reset           {email, code, newPassword}
```

Admin — either an owner session (cookies + `x-csrf-token`) or `x-admin-token: $ADMIN_TOKEN`.
An owner sees only their own businesses and their reviews; a platform admin and the token see
every one, and `/api/admin/users` is theirs alone:

```
GET    /api/admin/businesses
POST   /api/admin/businesses            {name, category, address, description, topics, googleReviewUrl,
                                         requireEmail, aiDrafts, googleSignin}
PATCH  /api/admin/businesses/:id        same fields, all optional. Never changes the slug.
DELETE /api/admin/businesses/:id
GET    /api/admin/businesses/:id/reviews
GET    /api/admin/reviews
PATCH  /api/admin/reviews/:id           {status: "visible" | "hidden"}
DELETE /api/admin/reviews/:id
PUT    /api/admin/reviews/:id/reply     {reply}   the business's public answer, up to 600 chars
DELETE /api/admin/reviews/:id/reply
GET    /api/admin/users                 platform admin only
PATCH  /api/admin/users/:id             {suspended: true | false}   platform admin only
```

For example:

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"name":"Blue Door Café","category":"Café","address":"18 Harbour Lane"}' \
     http://localhost:3000/api/admin/businesses
```

The slug is generated from the name and made unique (`blue-door-cafe`, then `blue-door-cafe-2`).

**The slug is permanent.** It is the one thing printed into every QR code, so `PATCH` deliberately
cannot change it: rename a business, move it, change its topics or its Google link, and the codes
already stuck to the counter keep working and keep their review history. Only `BASE_URL` and the
slug together decide what a code points at, and neither changes by accident.

`topics` takes an array or a comma-separated string. `googleReviewUrl` takes the "Ask for reviews"
short link from Google Business Profile, a Google Maps link, or a bare place id (which is expanded
to `https://search.google.com/local/writereview?placeid=…`). Non-Google hosts are rejected, so the
button cannot be pointed at an unrelated site.

## Printing QR codes

Each business has a PNG and an SVG at `/api/b/:slug/qr.png` and `/api/b/:slug/qr.svg`; add
`?download=1` to get a file instead of an inline image. Both use error correction level M, a quiet
zone of 2 modules, and dark ink on white. The admin console shows a preview and both download
buttons for every business.

```bash
curl -o blue-door-cafe-qr.svg "https://reviews.example.com/api/b/blue-door-cafe/qr.svg?download=1"
```

Printing notes:

- **Use the SVG for anything printed.** It is vector, so it stays sharp at any size; the PNG
  (640px) is for screens and quick previews.
- Print it at **at least 25mm square** for a code held in the hand, 40mm or more for a table tent,
  and much larger for a window — a rough rule is one tenth of the scanning distance.
- Keep the white border. That quiet zone is part of the code, so do not crop to the dark edge or
  print the code on a photo or a coloured panel.
- Keep real black on real white. Inverting the colours or going low-contrast breaks many scanners.
- Add a line of text above it, for example "Scan to leave a review", and test the printed copy
  with two or three actual phones before you print a hundred.
- The code contains `BASE_URL`, so **changing `BASE_URL` invalidates every code already printed.**
  Settle on the final domain before the first print run.

## NFC tags

A tag is the same link the QR code carries, written as an NDEF URI record. A phone held to it
opens the same profile page — same device cookie, same one review per business — so there is
nothing extra on the server, and a tag goes stale only when a printed code would: if `BASE_URL`
changes.

In the console, **NFC tag** under any business opens a panel holding the exact link to write, with
a **Copy link** button. On Chrome for Android it also offers **Write tag**: hold a tag to the back
of the phone and it is written on the spot, then **Lock tag** makes it permanent. The write buttons
only appear where Web NFC exists — Chrome on Android, over https, which is the deployed console and
not a LAN `http://` address. Safari has no Web NFC at all, so an iPhone can read tags but never
write them; there, copy the link into a tag-writing app (NFC Tools on Android, NXP TagWriter on
iPhone) as a URL record.

- One tag per business, each carrying its own slug.
- An **NTAG213** sticker has room to spare for a link this short. NTAG215 and 216 are the same
  thing with more memory, and cost more for nothing you need here.
- **Lock a tag once it is written and tested.** An unlocked tag on a counter can be rewritten by
  any phone that passes, which is how your review tag becomes somebody else's link. Locking is
  permanent in the hardware, not a setting this app can undo.
- **Keep the printed code as well.** Modern iPhones and most Android phones read tags without an
  app, but older handsets cannot read them at all, a tag can be peeled off, and a QR code works
  from across a room. The two cost almost nothing together.

## Deploying

### On Google Cloud

A Compute Engine e2-micro with Docker and Caddy in front. GCP's Always Free tier covers exactly
one e2-micro in `us-central1`, `us-west1` or `us-east1`, so this can genuinely run at **$0/month**
(within one instance, a 30GB standard disk and 1GB of North America egress). Any other region is
roughly $7-9/month.

```powershell
gcloud auth login                 # the account that should own the project
.\deploy\gcp-provision.ps1 -Project reviewqr-prod -Hostname reviewqr-yourname.duckdns.org
```

That creates the project, links billing, enables Compute Engine, reserves a static IP, opens 80
and 443 to that one machine, and boots a Debian 12 VM that installs Docker on first boot. It also
writes `.env.production` with a freshly generated `ADMIN_TOKEN` (git-ignored). It prints the IP
and is safe to run again.

Point the hostname at that IP - a DNS A record, or the subdomain box at
[duckdns.org](https://www.duckdns.org) if you are using a free one. **A certificate cannot be
issued for a bare IP address**, which is why a hostname is not optional: the app needs https for
Google One Tap, for the clipboard button and for its own `Secure` cookies.

Then install the app, from Git Bash:

```bash
bash deploy/gcp-deploy.sh --project reviewqr-prod
```

It waits for Docker to finish installing, packs the app (no `node_modules`, no local database),
sends one tarball, and runs `docker compose up -d --build` on the VM. **This is also the update
command** - run it again after any change, as often as you like. `--restart-only` skips the
rebuild when all you changed was `.env.production`.

The database and Caddy's certificates live on named Docker volumes, so a redeploy never touches
them, and `restart: unless-stopped` brings everything back after a reboot.

Day to day:

```bash
gcloud compute ssh reviewqr --project=reviewqr-prod --zone=us-central1-a
sudo docker compose -f /opt/reviewqr/compose.yaml logs -f        # or: logs caddy
sudo docker compose -f /opt/reviewqr/compose.yaml ps
```

To add a key later, edit `.env.production` and run the deploy script again with
`--restart-only`. Both the AI drafts and the Google prompt can also be switched off per business
in the admin console, so a key does not commit every business to using it.

**Back it up.** Everything is in the one SQLite file, on the VM's `reviewqr-data` volume. Use
SQLite's own backup rather than `cp`, so the copy is consistent against the WAL:

```bash
gcloud compute ssh reviewqr --project=reviewqr-prod --zone=us-central1-a
```

```bash
# on the VM: a throwaway container with sqlite3, reading the same volume
sudo docker run --rm -v reviewqr_reviewqr-data:/data -v /tmp:/out alpine:3 sh -c \
  'apk add --no-cache sqlite >/dev/null && sqlite3 /data/reviewqr.db ".backup /out/reviewqr-backup.db"'
exit
```

```bash
# back on your machine
gcloud compute scp reviewqr:/tmp/reviewqr-backup.db ./reviewqr-backup.db \
  --project=reviewqr-prod --zone=us-central1-a
```

To restore, put that file back as `/data/reviewqr.db` the same way and restart the app.

**Hardening worth doing later.** Port 22 is open to the internet (key-only, as GCP sets up). To
close it, add a firewall rule for the IAP range `35.235.240.0/20` on port 22, delete
`default-allow-ssh`, and add `--tunnel-through-iap` to the `gcloud compute ssh` calls in
`deploy/gcp-deploy.sh`.

### On Fly.io

The quickest route to a live https address, which is also what Google One Tap needs. Fly builds
the image on its own builder, so Docker is not needed locally.

**What it costs.** Fly's old free allowance is closed to accounts created after October 2024. A new
organization gets a short trial (roughly 2 VM hours or 7 days) and then needs a card. As configured
in `fly.toml` - one `shared-cpu-1x` machine with 512MB of memory, always on, plus a 1GB volume -
expect **roughly $4 a month**, from about $2.19 for a 256MB machine, ~$6/GB/month for memory above
that, and $0.15/GB/month for the volume. Dropping `memory` to `'256mb'` in `fly.toml` halves it and
is enough for this app; bandwidth is $0.02/GB in Europe and North America, which for QR traffic is
pennies. Check [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) before you commit,
since these numbers move.

```powershell
winget install --id Fly-io.flyctl    # or: iwr https://fly.io/install.ps1 -useb | iex
fly auth login                       # sign up or sign in
.\deploy\fly-deploy.ps1 -App reviewqr-your-name -Region ams
```

The script creates the app, creates the 1GB volume the SQLite file lives on, points `fly.toml` at
your app name and its `https://<app>.fly.dev` hostname, generates an `ADMIN_TOKEN` and stores it
as a Fly secret, deploys, waits for `/healthz`, and prints the admin password once. Running it
again is just a redeploy. `-Region` takes any Fly region (`fly platform regions` lists them);
pick the one nearest your customers.

Then set the keys you have, each of which restarts the app in a few seconds:

```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-...                      --app <app>
fly secrets set GOOGLE_CLIENT_ID=....apps.googleusercontent.com   --app <app>
fly secrets set SMTP_HOST=smtp.example.com SMTP_PORT=587 \
                SMTP_USER=... SMTP_PASS=... \
                'MAIL_FROM=Reviews <reviews@example.com>' --app <app>
```

Day to day: `fly logs`, `fly ssh console`, `fly status`, `fly deploy` to ship a change.

**One machine, on purpose.** SQLite has a single writer, so `fly.toml` pins the app to exactly one
machine and `fly deploy` is run with `--ha=false`. Scaling to two would give each machine its own
volume and its own, diverging database. If you outgrow one machine, that is the point at which
`db.js` moves to Postgres.

`fly.toml` sets `TRUST_PROXY=1`, because Fly puts a proxy in front of the app and without it every
request looks like it comes from the proxy, applying the per-IP rate limits to all your customers
at once.

**Back up the volume** - a Fly volume is a single disk, not a replicated store:

```bash
fly ssh sftp get /data/reviewqr.db ./reviewqr-backup.db --app <app>
```

Fly also takes daily volume snapshots, kept five days (`fly volumes snapshots list <volume-id>`).

### On a Node host

```bash
npm ci --omit=dev
export NODE_ENV=production
export BASE_URL=https://reviews.example.com
export ADMIN_TOKEN="$(openssl rand -base64 24)"
export DB_PATH=/var/lib/reviewqr/reviewqr.db
export TRUST_PROXY=1
export SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=... SMTP_PASS=...
export MAIL_FROM="Blue Door Café <reviews@example.com>"
node server.js
```

Run it behind nginx or Caddy for TLS, and keep a process manager (systemd, pm2) in front of it. A
minimal systemd unit:

```ini
[Service]
WorkingDirectory=/srv/reviewqr
EnvironmentFile=/srv/reviewqr/.env
ExecStart=/usr/bin/node server.js
Restart=always
User=reviewqr
```

`TRUST_PROXY=1` matters behind a proxy: without it every request looks like it comes from the
proxy's IP and the per-IP rate limits apply to all your customers at once.

### With Docker

```bash
docker build -t reviewqr .
docker run -d --name reviewqr -p 3000:3000 \
  -e NODE_ENV=production \
  -e BASE_URL=https://reviews.example.com \
  -e ADMIN_TOKEN=... \
  -e TRUST_PROXY=1 \
  -e SMTP_HOST=smtp.example.com -e SMTP_PORT=587 \
  -e SMTP_USER=... -e SMTP_PASS=... \
  -e MAIL_FROM="Reviews <reviews@example.com>" \
  -e ANTHROPIC_API_KEY=... \
  -v reviewqr-data:/var/lib/reviewqr \
  -e DB_PATH=/var/lib/reviewqr/reviewqr.db \
  reviewqr
```

The image defaults `DB_PATH` to `/data/reviewqr.db` and declares `/data` as a volume, so
`-v reviewqr-data:/data` with no `DB_PATH` works too. It runs as the non-root `node` user and has
a `HEALTHCHECK` on `/healthz`. It is the same image Fly builds and runs, so building it locally is
the fastest way to check a change before deploying:

```bash
docker build -t reviewqr:local .
docker run -d --name reviewqr-check -p 3222:3000 -v reviewqr-check:/data   -e BASE_URL=https://example.fly.dev -e ADMIN_TOKEN=at-least-sixteen-chars reviewqr:local
curl -s localhost:3222/healthz
```

### Backups

Everything is in the one SQLite file. With the app stopped, copy it. While it is running, use
`sqlite3 "$DB_PATH" ".backup /backup/reviewqr-$(date +%F).db"`, which is safe against the WAL that
the app enables for file-backed databases.

## Project layout

```
server.js        Express app, routes, sessions, CSRF, admin  (createApp is exported for tests)
db.js            Schema, slugs, demo seed
lib/env.js       .env reader and config, with startup validation
lib/security.js  Hashing, tokens, 6-digit codes, constant-time compare
lib/auth.js      Owner passwords: scrypt hashing, verification, the rules a password must meet
lib/ratelimit.js Sliding-window limits, in SQLite
lib/mail.js      Nodemailer, or the console in development
lib/google.js    Verifies Google One Tap ID tokens against Google's signing keys
lib/ai.js        Prompt, Messages API call, draft validation, template fallback
public/          index.html, business.html, admin.html, style.css, business.js, admin.js
test.js          npm test
compose.yaml     Production stack: the app plus Caddy, which handles HTTPS
fly.toml         Fly.io app config: one machine, a volume at /data, /healthz checks
deploy/          Caddyfile, and the scripts that stand each host up:
                 gcp-provision.ps1  create the GCP project, IP, firewall and VM
                 gcp-startup.sh     what the VM runs on first boot (Docker, swap)
                 gcp-deploy.sh      ship the app, and every update after that
                 fly-deploy.ps1     the same job for Fly.io
```

## Ideas for next steps

- **More than one person per business.** Owner accounts exist, but a business has exactly one
  owner: a venue with a manager and an assistant still shares a password. Invites, and handing a
  business to somebody else, are the missing half.
- **Claiming a business.** One created with `ADMIN_TOKEN` has no owner, and only a platform admin
  sees it. A screen for assigning those would finish the story.
- **Photos.** One image per review, resized on upload, with its own moderation queue.
- **Email the business** when a new review lands, especially a 1- or 2-star one, so they can
  respond the same day.
- **Printable QR sheets.** A `/b/:slug/poster` page sized for A5 and A4, with the business name and
  a short call to action, ready for the printer.
- **A dashboard over time.** Average rating by week, topic frequency, and the share of visitors who
  scan and then actually post.
- **Spam and abuse review.** The honeypot, the email check and the rate limits handle casual noise;
  a queue that holds a first-time reviewer's post for approval would handle the determined case.
- **Private feedback channel.** A short "anything we could do better?" box shown to everyone after they post, kept internal. Offered to all ratings, never as a diversion for unhappy customers.
- **Make the draft service pluggable.** `lib/ai.js` is already behind one interface, so a
  self-hosted model or a per-business tone of voice would be a contained change.
- **Postgres for scale.** SQLite is the right call for one venue or a few dozen. `db.js` is the
  only file that would need to change.
