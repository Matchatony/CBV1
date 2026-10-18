# Crackbotics

One-page marketing site and a print-ready flyer for Crackbotics — custom CNC
aluminum parts for FTC teams.

Plain HTML and CSS. No build step, no dependencies, no framework. Open the
files in a browser and they work; drop the folder on a host and it's live.

```
.
├── index.html      one-page site
├── styles.css      site styles (all colors are CSS variables at the top)
├── flyer.html      8.5 x 11 flyer, print-ready
├── flyer.pdf       the flyer, already exported — hand this to a print shop
├── flyer-copy.txt  flyer wording as plain text, for tweaking
├── COPY.md         taglines, voice notes, claims to be careful with
├── favicon.svg
└── github-pages.yml  optional GitHub Actions workflow (see below)
```

## Fill these in first

Both pages ship with placeholders. Search and replace:

| Placeholder | Where |
|---|---|
| `https://discord.gg/YOUR-INVITE` | `flyer.html` (6x — one per tear-off tab) |
| `hello@crackbotics.com` | `flyer.html` |
| `crackbotics.com` | `flyer.html` |
| QR code box | `flyer.html` — see below |
| Product photos | `index.html` — see below |
| Logo image | `index.html` — see below |

## The order form

A request can carry up to 10 design files (10 MB each, 50 MB together). Each
file gets its own row with a quantity, and the estimate prices each one on its
own line: DXF plates and STL / 3MF prints are measured in the browser and
priced; STEP plates and anything the page can't measure are listed as "priced by
hand", and the total then reads "$X + hand quote". One delivery fee covers the
whole order. Click a file's name to preview it.

Sending a quote is three steps:

1. **The bot check.** Cloudflare Turnstile runs on the form as it scrolls into
   view, invisibly unless Cloudflare wants a click, and `api/human.js` trades
   its token for a signed pass that lasts 20 minutes. See **Bot protection**
   below; until its keys are set this step is skipped.
2. **The design files go to Vercel Blob.** The browser uploads them one at a time, straight
   to the `crackbotics-uploads` Blob store on the Vercel project, using
   `vendor/blob-upload.js` (the `@vercel/blob` client, bundled). The small
   function `api/upload.js` only hands out a short-lived upload token, only to
   a request carrying the pass, and only
   for `quotes/*.dxf|step|stp|stl|3mf|pdf|zip` files up to 10 MB, each given
   an unguessable random suffix. The store is connected to the project, which
   is what sets `BLOB_READ_WRITE_TOKEN`. Free on the Hobby plan within its
   Blob limits.
3. **`api/order.js` saves the order and emails it.** It checks the pass, saves
   the order to the log (see **Order admin**) and sends the form's fields through
   [FormSubmit](https://formsubmit.co)'s AJAX endpoint, from the server, to
   `FORMSUBMIT_TO` (default anthonyhuynh980@gmail.com), copying
   `FORMSUBMIT_CC` (default crackboticssandiego@gmail.com; comma-separate to add
   more, set it empty for none). The first file's download link is in the
   `design_file` field and the rest in `design_file_2`, `design_file_3` and so
   on. The quote PDF and the summary list every file with its quantity, size and
   price. FormSubmit strips CAD attachments, which is why files travel as links.
   The control fields (`_subject`, `_template`, `_cc`) are set by the server, never
   taken from the request.

**If the server's email fails** (FormSubmit down, refusing Vercel, or wanting
activation), `api/order.js` returns the FormSubmit URL and the page posts the
form there itself, the old way: a plain form post into a hidden iframe, which
FormSubmit redirects to `sent.html` (the `_next` field), which is how the page
knows it went through, so keep `sent.html` deployed. The order is saved either
way.

If an upload fails, the details are still sent with that file's link saying
UPLOAD FAILED, and the customer is asked to email the files that didn't make it
(named in the message).

To browse or delete uploaded files: Vercel dashboard, then Storage, then
`crackbotics-uploads`.

**Activation.** FormSubmit activates a form per website: the first submission
from a new site triggers an **Activate Form** email to that Gmail instead of
the quote. crackbotics.com and crackbotics.vercel.app are activated. The
server names `FORMSUBMIT_SITE` (default https://crackbotics.com) as the site it
sends from, so it uses that activation.

To change where requests land, set `FORMSUBMIT_TO` in Vercel (and activate the
new address the same way). After activating, FormSubmit also offers a
random-string alias you can use in place of the email; since the address now
lives only on the server, it never appears in the page.

How it behaves:

- The visitor stays on the page and gets an inline "sent" message. If neither
  the server's email nor the fallback post can be confirmed, the page says so.
  The upload gives up after 2 minutes and the send after 60 seconds, so the
  button never gets stuck on "Sending…".
- The field named `email` becomes the **Reply-To**, so hitting reply in your
  inbox answers the team directly.
- `_subject` titles the email, `_template` lays it out as a table, and `_honey`
  is a hidden honeypot: a bot that fills it in is told "sent" and nothing is
  saved or emailed. The page also refuses a form finished in under 3 seconds.
- If the send fails (service down, ad blocker, visitor offline) the page
  explains why and offers to open their mail app with the same details
  pre-filled. The file has to be attached by hand there, since a mailto link
  can't carry it.
- The page refuses files over 10 MB up front, matching the upload limit, plus
  an 11th file, more than 50 MB in all, a duplicate, or an unsupported type,
  saying which file and why.

## Bot protection

The quote form's three endpoints (`api/human.js`, `api/upload.js`,
`api/order.js`) are public, so a bot can skip the page and call them directly.
Three layers stop that:

1. **Cloudflare Turnstile** (free). With it on, uploads and orders need the
   pass from `api/human.js` (code in `api/_lib/guard.js`), which only a solved
   Turnstile check gets. Real visitors almost never see a challenge. To turn it
   on:
   1. Sign in at dash.cloudflare.com (a free account is enough; the domain
      doesn't need to be on Cloudflare), open **Turnstile**, and **Add widget**.
   2. Name it Crackbotics, add the hostnames `crackbotics.com` and
      `crackbotics.vercel.app`, and choose **Managed** mode.
   3. In Vercel → Settings → Environment Variables, add `TURNSTILE_SITE_KEY`
      and `TURNSTILE_SECRET_KEY` with the two keys it shows, for Production,
      then redeploy.

   Both must be set; with either missing the check is off and the form works
   as before. The pass is signed with a key derived from `ORDERS_KEY`.
2. **Rate limits per IP address**, in the functions: 8 orders, 20 bot checks
   and 40 upload tokens per 10 minutes. They live in each function instance's
   memory, so they stop bursts but reset when Vercel starts a fresh instance.
3. **The Vercel Firewall**, in the dashboard under the project's **Firewall**
   tab: turn on **Bot Protection** (it challenges known bad bots before they
   reach the site), and keep **Attack Challenge Mode** in mind as the emergency
   switch if the site is ever flooded. If your plan includes a rate-limit rule,
   add one for paths starting with `/api/`.

The admin panel and the Claude connector need their own long keys, so these
layers don't apply to them.

## Order admin (admin.html)

Every quote request is also saved to an order log you can manage at
`/admin.html` (not linked anywhere on the site, and hidden from search engines).
Sign in with the `ADMIN_PASSWORD` set in Vercel → Settings → Environment
Variables. There you can see every order, download its design files, set a
status (New → Quoted → Paid → In progress → Ready → Done / Cancelled), keep
private notes, search, filter, and delete an order (optionally with its files).
Each order carries the full spec the customer chose (`specs`: CNC / 3D print /
other, material, quantity, color, infill and walls, CNC options, rush, measured
size, file type, price breakdown or hand-quote reason, and per file in
`specs.items`), shown as tags on the list
and in Job / Price / Customer / Delivery sections when opened; filter by type from
the toolbar. An order with several files shows a table of them (quantity,
measured size, price or why it's priced by hand), and its upload links are in
`files`. Orders from before specs were saved show their original quote text,
and single-file orders from before `files` existed still work.

**Download files** saves the design files for the orders on screen as one ZIP
(every file of every order), with an `orders.csv` index, one row per file.

The **Deliveries** tab plans handoffs. Drop-offs are scheduled automatically:
once an order is Paid, In progress or Ready it goes on the delivery day the
customer was promised (orders close Mon/Wed/Fri at 6 pm and go out the next
day, the same rule as the quote form's `CUTOFF_DAYS` / `CUTOFF_HOUR` — keep the
two in step), or the next delivery day if that has passed, as the last stop.
Use Edit to move one; overdue days get a "Move to <next day>" button, and
"Optimize order" sorts a day's stops into the shortest straight-line route from
the fab shop (exact up to 12 stops). Pickups have no batch, so they only get a
day if you set one. Each day lists drop-offs in route order (reorder with ↑/↓) plus pickups, with
an "Open route in Maps" link (Google Maps, starting from where you are), a
printable run sheet, an "Email time" button that drafts the customer email,
and "Delivered" / "Picked up" to mark it done (undo within 14 days).
A map at the top pins every drop-off still to do, colored by day and numbered
in route order. Each address is looked up once with OpenStreetMap's Nominatim
and the position is saved on the order; editing the address looks it up again.
The fab shop shows as a FAB marker. Its address lives in the `FAB_ADDRESS`
environment variable (not in the page source, which is public) and is only sent
to a signed-in admin; set `FAB_LATLON` to `lat,lon` to pin it exactly instead of
looking it up. Scroll or pinch to zoom; "Show all" zooms back out to everything.

- `api/order.js` saves a request and emails it (called by the quote form).
- `api/human.js` and `api/_lib/guard.js` are the bot check and rate limits (see **Bot protection**).
- `api/orders.js` lists / updates / deletes; every call needs the password.
  Its update rules live in `api/_lib/changes.js`, shared with the Claude connector.
- `api/mcp/[key].js` is the Claude connector (see below).
- Records live in the `crackbotics-uploads` Blob store under `orders/`,
  encrypted with `ORDERS_KEY`. **Never change `ORDERS_KEY`**: every existing
  order would become unreadable. `ADMIN_PASSWORD` can be changed any time
  (then redeploy).
- The email is still the primary record; if saving to the log ever fails,
  the request still arrives by email.

## Claude connector

Claude (in Cowork and the Claude apps) can work with the order log through a
custom connector: a remote MCP server at `/api/mcp/<key>` (`api/mcp/[key].js`,
built on `@modelcontextprotocol/server`, stateless Streamable HTTP). It has its
own key, `CLAUDE_CONNECTOR_KEY`, separate from `ADMIN_PASSWORD`, so it can be
revoked on its own.

Its tools: `list_orders` (filter by status, type, text, limit), `get_order`,
`update_order` (status, notes), `schedule_delivery` (day, time window, stop) and
`mark_delivered`, plus `analyze_part_file` (below). That's all: it can't delete
orders, change passwords or keys, or see environment variables or settings. Edits go through the same checks as the
admin panel (`api/_lib/changes.js`), and every change it makes is saved on the
order and shown under **History** when you open the order in `admin.html`.

**STEP file analysis.** `analyze_part_file` downloads an order's STEP files
(only the order's own files, from this project's Blob store; all of them, or one
with `file: N`) and measures each part with
OpenCascade (`occt-import-js`, the same WebAssembly build the quote page uses for
its 3D preview), in `api/_lib/step.js`. Per part it reports:

- thickness and the matching stock size (1/8 to 1/2 in.)
- plate size and stock area
- total cut length
- round holes by diameter, other cutouts, and pockets (area and depth)
- identical copies, grouped
- flags for anything that needs a hand quote: sloped or curved faces
  (chamfers, fillets, 3D shapes), features on the bottom face, holes smaller
  than the 1/8 in. tool, and a thickness that doesn't match the stock on the
  order
- estimated machine minutes, kWh and electricity cost, per part, for the
  quantity ordered of that file, and for all the order's files together
- a top-view picture (gray plate, blue pocket floors, grid every 10 mm)

The time estimate uses the shop constants at the top of `api/_lib/step.js`
(copied from `RATE` in `index.html`: setup, feed, depth per pass, per-hole time,
plus a pocket stepover); it's an estimate, not a CAM toolpath. Electricity is
machine minutes × `SHOP_MACHINE_KW` × `SHOP_USD_PER_KWH`. Set those two env vars
in Vercel to the router's real draw (router, spindle and dust collection
together) and the SDG&E rate; until then the placeholders are 1.5 kW and
$0.45/kWh. Files over 1,000 CAD faces are turned away (meshing them takes too
long for the function's 60 s limit, set in `vercel.json`), as are DXF and other
file types: DXFs are already priced by the quote page.

**Set it up**

1. Generate a key: `openssl rand -hex 32`
2. In Vercel → the project → Settings → Environment Variables, add
   `CLAUDE_CONNECTOR_KEY` with that value, for **Production** only. Then redeploy
   (Deployments → the latest one → ⋯ → Redeploy); env var changes only apply to
   new deployments.
3. In Claude: Settings → Connectors → Add custom connector. Give it a name
   (e.g. "Crackbotics orders") and the URL
   `https://crackbotics.com/api/mcp/<key>`. Leave the advanced OAuth settings empty.

Treat that URL like a password: anyone who has it can read and change orders
(but not delete them). Only add it to Claude accounts that admins use. On a
Claude Team or Enterprise plan, a connector an owner adds for the whole
organization is available to everyone in it.

**Revoke it:** delete `CLAUDE_CONNECTOR_KEY` in Vercel (or replace it with a new
key), then redeploy. The old URL stops working as soon as the new deployment is
live. With a new key, update the URL in Claude's connector settings.

- With `CLAUDE_CONNECTOR_KEY` unset (or under 32 characters) the connector is
  off. A missing key, a wrong key and a switched-off connector all get the same
  plain 404.
- The key is part of the URL, so it appears in this project's Vercel request
  logs; anyone with access to the logs can see it.
- Try it locally with MCP Inspector (`npx @modelcontextprotocol/inspector`,
  transport Streamable HTTP, URL `http://localhost:3000/api/mcp/<key>`).
- `robots.txt` already keeps crawlers out of `/api/`; the connector isn't listed
  anywhere on the site.

## Adding your photos

Each product card has a placeholder `<div class="photo">`. Drop your images in
`images/` and swap the div for an `img` — the styles already match:

```html
<!-- before -->
<div class="photo" data-label="Photo: plates"></div>
<!-- after -->
<img src="images/plates.jpg" alt="Pocketed aluminum plates">
```

Shoot them 4:3 and roughly 1200px wide. Parts on a clean, plain background
(a workbench is fine, a cluttered one isn't) photograph better than parts on
a robot. Compress before committing — a 4MB phone photo will make the page
feel slow on venue wifi.

There's also a commented-out `og:image` tag in `index.html` for the link
preview when you paste the site into Discord. Worth filling in.

## Adding the QR code

Generate a PNG pointing at your Discord invite (or the site), save it as
`images/qr.png`, then in `flyer.html` replace the whole `<div class="qr">…</div>`
block with:

```html
<img class="qr" src="images/qr.png" alt="Scan for our Discord">
```

To generate one locally:

```sh
qrencode -o images/qr.png -s 12 -m 1 'https://discord.gg/YOUR-INVITE'
```

Print it at least 1 inch square (the placeholder is 1.6in, which is comfortable)
and test-scan the actual printed sheet before you run 50 copies.

## Printing the flyer

`flyer.pdf` is already exported at 8.5 x 11 and ready to hand to a print shop.

If you edit `flyer.html`, re-export it: open the file in Chrome, Ctrl/Cmd+P, then

- Destination: **Save as PDF**
- Paper: **Letter**
- Margins: **None**
- Scale: **100%**
- **Background graphics: ON** ← without this the black header prints white

The bottom strip is tear-off tabs with your Discord URL. If you'd rather post a
plain sheet, delete the `<div class="tabs">…</div>` block — the layout closes up
on its own.

Printing tips: plain paper is fine for a bulletin board and cheaper to replace
when someone tears all the tabs off. Colour matters here — the orange is doing
most of the attention-grabbing, so a black-and-white print loses a lot.

## Deploying

The live site is on Vercel at **crackbotics.com** (crackbotics.vercel.app
redirects there). The order form, uploads and admin need Vercel's functions, so
the Cloudflare and GitHub Pages options below only suit a static copy.

**SEO:** `robots.txt` and `sitemap.xml` sit at the root (update `<lastmod>` and add
new public pages to the sitemap). `index.html` carries the title/description,
Open Graph tags with `images/og-image.jpg` (1200×630, used for link previews in
Discord, iMessage, etc.), canonical links to crackbotics.com, and JSON-LD
structured data (LocalBusiness: name, logo, email, San Diego service area, the
two services). `404.html` is the not-found page. www.crackbotics.com and
crackbotics.vercel.app redirect to crackbotics.com. Three.js and jsPDF load only
when a visitor nears the quote form, to keep the first page load light.
The icon Google shows next to search results comes from the `rel="icon"` links
(`favicon.ico` at 48×48, `favicon-192.png`, `favicon.svg`); Google needs a square
icon at a multiple of 48 px and refreshes it on its own schedule.

**Analytics:** the public pages load Vercel Web Analytics
(`/_vercel/insights/script.js`) — cookieless, anonymous page-view counts, described
in `privacy.html#analytics`. It only records once Analytics is enabled on the
Vercel project (dashboard → the project → Analytics → Enable). `sent.html` loads it
too, so its page views count successful quote requests. `admin.html` deliberately
doesn't load it.

### Cloudflare Pages (recommended — it's the faster CDN and the free tier is generous)

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Pick the repo, then set:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** *(leave empty — the site is at the repo root)*
4. Save and Deploy. You get `your-project.pages.dev` in about a minute.
5. Custom domain: Pages → your project → Custom domains → add `crackbotics.com`.
   If the domain is registered at Cloudflare, DNS is automatic.

Every push to your default branch redeploys.

### GitHub Pages

The site is at the repo root, so Pages can serve it with no build. Move the
included workflow into place:

```sh
mkdir -p .github/workflows
git mv github-pages.yml .github/workflows/pages.yml
```

Then in the repo: Settings → Pages → Source: **GitHub Actions**. Push, and the
site lands at `https://<user>.github.io/crackBotics/`.

All links here are relative, so serving from a subpath needs no changes. For a
custom domain, add a `CNAME` file next to `index.html` containing just your
domain.

Pages on a private repo needs GitHub Pro. On a free account, make the repo
public first or stay on Vercel.

### Testing locally

```sh
python3 -m http.server 8000     # then open http://localhost:8000/
```

Or just double-click `index.html` — there's no JavaScript or fetching, so
`file://` works fine.

## Editing the design

All colors are CSS variables at the top of `styles.css`:

```css
--ink:    #15181c;   /* near-black, used for the nav, hero, footer */
--accent: #ff6b1a;   /* machining orange — the one attention color */
```

Change `--accent` and the whole site (buttons, headings, closer band) follows.
The flyer keeps its own copy of the variables at the top of `flyer.html` so it
stays a single self-contained file you can email to a print shop — if you change
the brand color, change it in both places.

The site is one file with commented section markers (`HERO`, `WHY US`,
`PRODUCTS`, `PRICING / ORDER`, `TEAM`), so sections can be reordered or deleted
by moving a block.

## Worth doing next

- **Put real prices on the site.** "We're cheap, ask us" converts worse than
  three anchor prices. The undercut angle only lands if people can see it.
- **Add a comparison table** once you have numbers: your price vs. theirs, for
  three parts you actually sell. That's the single most persuasive thing you
  could add, and it's about 20 lines of HTML.
- **Ask teams to link you.** FTC teams post resources on their own sites; a link
  from a few of them is more traffic than any SEO work you'd do on a one-pager.
