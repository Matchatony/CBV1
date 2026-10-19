# Crackbotics

One-page marketing site and a print-ready flyer for Crackbotics — custom CNC
aluminum parts for FTC teams.

Plain HTML and CSS. No build step, no dependencies, no framework. Open the
files in a browser and they work; drop the folder on a host and it's live.

```
.
├── index.html      one-page site
├── styles.css      site styles (all colors are CSS variables at the top)
├── discount-first.html  landing page for crackbotics.com/discountFirst
├── status.html     customer order status lookup
├── sponsor.html    Sponsored Team Program application
├── file-guide.html how to export DXF / STEP / STL / 3MF from Onshape and Fusion 360
├── step-measure.js measures STEP plates (quote page and Claude connector share it)
├── flyer.html      8.5 x 11 flyer, print-ready
├── flyer.pdf       the flyer, already exported — hand this to a print shop
├── flyer-copy.txt  flyer wording as plain text, for tweaking
├── COPY.md         taglines, voice notes, claims to be careful with
├── favicon.svg
└── github-pages.yml  optional GitHub Actions workflow (see below)
```

## Fill these in first

The flyer's placeholders are filled in: Discord `discord.gg/bJsQCynzec`, email
crackboticssandiego@gmail.com, and a QR code to crackbotics.com/discountFirst.
Still to set up (each is explained in its section below):

| What | Where |
|---|---|
| Gmail app password, for customer confirmation emails | Vercel env `GMAIL_APP_PASSWORD` — see **Confirmation email** |
| Cloudflare Turnstile keys | Vercel env — see **Bot protection** |
| Product photos, logo image | `index.html` — see below |

## The order form

A request can carry up to 10 design files (10 MB each, 50 MB together). Each
file gets its own row with a quantity, and the estimate prices each one on its
own line: DXF and STEP plates and STL / 3MF prints are measured in the browser
and priced; anything the page can't measure is listed as "priced by hand", and
the total then reads "$X + hand quote". One delivery fee covers the whole order.
Click a file's name to preview it.

**STEP plates.** `step-measure.js` (the same code the Claude connector's
`analyze_part_file` uses) reads each solid in the model: plate size, thickness,
cut length, holes and pockets. Each plate is priced like a DXF plate, with
material for its real thickness (a 1/4 in. plate costs twice the 1/8 in.
material) and machine time that includes clearing its pockets. A file with
several plates is priced as a set. Something unusual is still priced, but the
quote tells the customer, and the order gets **checks** for you
(`specs.items[].checks`):

- sloped or curved faces (chamfers, fillets, a 3D shape), or features cut into
  both faces: the multiple setups / unusual geometry add-on (+$8 a part) is
  added, unless the customer already ticked it
- a step cut around the outside edge (not in the price)
- holes smaller than the 1/8 in. tool
- a thickness other than the 1/8 in. on the order
- several different parts in one file

Such an order arrives with "(check before confirming)" in the email subject and
a `check_before_confirming` field at the top, and shows a **Check** tag and the
list in `admin.html`. Only a model with no flat plate in it, or one thicker than
1/2 in., goes to a hand quote.

**Getting it to them.** Three choices: free pickup in San Diego, local delivery
in the San Diego area for a flat $15.99, or **Ship it** anywhere in the US by USPS
Priority Mail. Delivery and shipping both ask for an address.

**Shipping estimates.** For Ship it, the quote picks the cheapest USPS Priority
Mail Flat Rate box the priced parts fit (`shipBox()` in `index.html`): plates lie
flat in one stack, printed parts each have to fit and together fill at most 60%
of the box, with 1/4 in. of packing on every side and the 70 lb limit. That box's
price goes into the total, and the order records the box (`specs.shipping_box`,
cost in `specs.price.delivery`). Parts too big for any flat rate box, or an order
with a file priced by hand, read "$X + shipping" and you quote shipping by email.
The box sizes and prices are `SHIP_BOXES` / `SHIP_HOLIDAY` near the top of the
script: retail prices from USPS Notice 123 (July 12, 2026), with the holiday
prices from Oct 4, 2026 to Jan 17, 2027. **USPS changes prices about every
January and July: update them there.**

**Discount codes.** The form has a Discount code box with an Apply button. Codes
are made in the admin panel (**Discounts**, below) and checked by
`api/discount.js`; a good code takes its percent or dollar amount off the priced
parts (never delivery or shipping) and shows as its own line in the estimate,
the PDF and the email. A code that's wrong, switched off, past its end date or
used up stops the send until the customer fixes or clears it. `api/order.js`
checks the code again when the order comes in, counts the use, and writes in the
email's `discount_code` field whether it checked out. On a hand quote the code is
recorded for you to take off the price you send.

**The first-order link: crackbotics.com/discountFirst.** Give this link out for 5%
off a team's first order. It opens `discount-first.html` (`vercel.json` rewrites
`/discountFirst`, `/discountfirst`, `/DiscountFirst`, `/DISCOUNTFIRST` and
`/discount-first` to it), which says the discount is claimed and saves the code
`FIRST5` on the device. Its **Start your quote** button opens the quote form
with the code filled in and a note at the top saying so. If the device has used
it already, or the code is off, the page says that instead.

`FIRST5` is created automatically the first time anything reads the codes, as a
**one per team** code (edit, turn off or delete it like any other; deleting it
doesn't bring it back). One per team, without accounts, works like this: when
an order uses the code, the server remembers the customer's email (lowercased,
with Gmail dots and `+tags` removed), team number and a random device id the
browser keeps, as one-way hashes stored with the code. A later order that matches
any of the three is refused, on the form and again by `api/order.js`. A one-per-team
code needs a team number. Your own emails (`SHOP_EMAILS`, default
anthonyhuynh980@gmail.com and crackboticssandiego@gmail.com) are never limited
or remembered, so you can use it as often as you like. It's not airtight: someone
with a new email, a different team number and cleared browser data gets it
again, but it takes deliberate effort, and you see the team on every order.

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

**Confirmation email.** Right after a request is saved, `api/order.js` emails
the customer a confirmation (`api/_lib/confirm.js`) from
crackboticssandiego@gmail.com through Gmail: their order number, the estimate,
how it gets to them, a **Track your order** link to the status page, and what
happens next. Replies go to the shop inbox. It only contains text the site wrote
(plus the customer's first name), so the form can't be used to mail spam, and an
address gets at most 3 a day. It's off until you turn it on:

1. The Google account crackboticssandiego@gmail.com needs 2-Step Verification on
   (Google Account → Security).
2. Make an app password: Google Account → Security → 2-Step Verification → **App
   passwords** (or search "App passwords" in the account settings). Name it
   Crackbotics; Google shows a 16-letter password once.
3. In Vercel → Settings → Environment Variables, add `GMAIL_APP_PASSWORD` with
   that password (Production), then redeploy. (`GMAIL_USER` defaults to
   crackboticssandiego@gmail.com.)

Gmail sends up to about 500 emails a day from one account, far more than the
shop needs. Revoke the app password in Google to turn it off again.

**Order status page.** `status.html` (with `api/status.js`) shows a customer
where their order is: Received → Quoted → Paid → Being made → Ready →
Shipped / Delivered / Picked up, plus the delivery day or the tracking number.
It needs both the order number and the email it was placed with, shows nothing
private (no notes, files or address), and is rate-limited. The quote form's
"Sent" message and the confirmation email link to it with both filled in. Add a
shipped order's USPS tracking number in the admin panel's **To ship** list (or
with the Claude connector's `update_order`), and it shows on the status page
with a link to USPS tracking.

**Sponsored Team Program.** `sponsor.html`, at crackbotics.com/sponsorships (`vercel.json`
rewrites `/sponsorships`, `/Sponsorships`, `/SPONSORSHIPS`, `/sponsorship` and `/sponsor`;
**Sponsorships** in the top menu, in the accent color) is the 2026–2027 application for the ~10 sponsored teams:
team number and name, city and state, the contact's name, role and email (plus a
coach's email for students), and their competition results, community
involvement, how they share their work, links, why CrackBotics, and parts
they'll need. `api/sponsor.js` checks it (same Turnstile pass, honeypot and
per-IP limit as the quote form), saves it encrypted under `sponsors/` in the Blob
store, and emails it to the shop through FormSubmit with the applicant as
Reply-To. Applications close at the end of Oct 25, 2026 (San Diego time): set by
`APPLY_CLOSES` in `api/_lib/sponsors.js` and `CLOSES` in `sponsor.html` (change both
for next season); after it the page shows "closed" and the server refuses new ones.
Review them in the admin panel's **Sponsors** tab (`api/sponsors.js`):
filter by status (New, Reviewing, Accepted, Declined), keep private notes, reply
by email, or delete. Questions and limits live in `api/_lib/sponsors.js`
(`FIELDS`) and the form in `sponsor.html`; change both together.

**FAQ and file guide.** The home page has an FAQ (`#faq`), and
`file-guide.html` explains exporting DXF, STEP, STL and 3MF from Onshape and
Fusion 360; the quote form links to it under the file picker.

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
- Each job type takes only its own files: CNC plates DXF or STEP, 3D prints
  STL or 3MF, "Something else" any of those plus PDF or ZIP. The file picker's
  filter is only a hint (anyone can pick "All files" or drop a file in), so
  `addFiles()` checks it, and switching the job type removes files the new type
  doesn't take, saying which and why.
- The page refuses files over 10 MB up front, matching the upload limit, plus
  an 11th file, more than 50 MB in all, or a duplicate, saying which file and why.

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
2. **Rate limits per IP address**, in the functions: 8 orders, 20 bot checks,
   40 upload tokens and 15 discount-code checks per 10 minutes (the last so
   codes can't be found by guessing). They live in each function instance's
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

An order with a discount code shows it under Price (the amount taken off, or, if
the code had stopped working by the time the order came in, a warning that the
estimate still includes it). Shipped orders say **Plus shipping** there.

**Discounts** (third tab) lists every code with how many times it's been used,
its end date and status, and makes new ones: the code (3 to 24 letters, digits,
`-` or `_`; customers can type it in any case), % or $ off, an optional end date
(it works through that day, San Diego time), an optional use limit, and a
private note, and **One per team** (see the first-order link above). **Turn off**
stops a code without losing its count. Codes are
stored encrypted next to the orders (`settings/discounts/` in the Blob store,
`api/discounts.js`, `api/_lib/discounts.js`). Use counts are best effort: two
orders at the same instant can count as one.

**Download files** saves the design files for the orders on screen as one ZIP
(every file of every order), with an `orders.csv` index, one row per file.

The **Deliveries** tab plans handoffs. Orders to ship are listed first, under
**To ship**, once they're Paid, In progress or Ready: each has the address, an
**Email tracking** button (a pre-filled email to paste the tracking number into)
and **Shipped**, which marks it done. They never go on a delivery day or the map.
Drop-offs are scheduled automatically:
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
- `api/discount.js` checks a code for the quote form; `api/discounts.js` (password) makes and edits them.
- `api/status.js` answers the customer status page; `api/_lib/confirm.js` writes and sends the confirmation email.
- `api/sponsor.js` takes sponsorship applications; `api/sponsors.js` (password) lists and updates them; `api/_lib/mail.js` sends the shop's FormSubmit emails.
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
its 3D preview) and `step-measure.js` (the same measuring the quote page prices
STEP plates with), in `api/_lib/step.js`. Per part it reports:

- thickness and the matching stock size (1/8 to 1/2 in.)
- plate size and stock area
- total cut length
- round holes by diameter, other cutouts, and pockets (area and depth)
- identical copies, grouped
- flags for anything a plain flat plate wouldn't have: sloped or curved faces
  (chamfers, fillets, 3D shapes), features on both faces, a step around the
  outside edge, and holes smaller than the 1/8 in. tool
- estimated machine minutes, kWh and electricity cost, per part, for the
  quantity ordered of that file, and for all the order's files together
- a top-view picture (gray plate, blue pocket floors, grid every 10 mm)

The time estimate uses the shop constants at the top of `api/_lib/step.js`
(copied from `RATE` in `index.html`: setup, feed, depth per pass, per-hole time,
plus a pocket stepover); it's an estimate, not a CAM toolpath. Electricity is
machine minutes × `SHOP_MACHINE_KW` × `SHOP_USD_PER_KWH`. The defaults are the
shop's Shapeoko 5 Pro 2x2 with the Carbide Compact Router at rated draw (router
about 6.5 A at 120 V, ~780 W; machine rated 4 A, ~440 W; 1.2 kW together, an upper
bound, since real cuts draw less) and SDG&E's 2026 blended residential rate,
about $0.49/kWh. To use a measured figure (a plug-in power meter on the
machine's outlet strip) or add a shop vac, set those two env vars in Vercel. Files over 1,000 CAD faces are turned away (meshing them takes too
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

## The QR code

The flyer's QR code is an inline SVG in `flyer.html` (`<figure class="qr">`),
pointing at https://crackbotics.com/discountFirst, captioned "Scan for 5% off
your first order". To point it somewhere else, generate a new code (for example
`qrencode -t SVG -m 0 'https://…'`) and swap the `<svg>` in. It prints at 1.45 in.
square; test-scan the actual printed sheet before you run 50 copies.

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
