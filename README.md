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

The form posts to [FormSubmit](https://formsubmit.co) at
`https://formsubmit.co/anthonyhuynh980@gmail.com` (the `<form action>` in
`index.html`). FormSubmit emails every submission to that address, with the
design file attached. It's free, including file uploads up to 10 MB.
It's a plain form post into a hidden iframe, **not** FormSubmit's `/ajax/`
endpoint, because that endpoint drops file attachments. FormSubmit then
redirects the iframe to `sent.html` (the `_next` field), which is how the page
knows the send went through, so keep `sent.html` deployed next to
`index.html`.
(Formspree was used before, but its free plan rejects file uploads, and the
design file is required here, so every request failed.)

**One-time activation.** The very first submission doesn't arrive as a quote:
FormSubmit emails that Gmail an **Activate Form** link instead. Click it once
and every submission after that comes through. Until then the site says it
couldn't confirm the send when someone submits.

To change where requests land, change the email at the end of the
`<form action>` URL (and activate the new address the same way). After
activating, FormSubmit also offers a random-string alias you can use in place
of the email so the address isn't visible in the page source.

How it behaves:

- The visitor stays on the page and gets an inline "sent" message. If
  FormSubmit shows its own page instead (an error, or activation still
  pending), the page says it couldn't confirm the send. A send that hasn't
  finished after 90 seconds is reported as failed, so the button never gets
  stuck on "Sending…".
- The field named `email` becomes the **Reply-To**, so hitting reply in your
  inbox answers the team directly.
- `_subject` titles the email, `_template` lays it out as a table,
  `_captcha=false` skips FormSubmit's CAPTCHA page, `_next` is the redirect
  back to `sent.html`, and `_honey` is a hidden honeypot that drops bot
  submissions.
- If the post fails (service down, ad blocker, visitor offline) the page
  explains why and offers to open their mail app with the same details
  pre-filled. The file has to be attached by hand there, since a mailto link
  can't carry it.
- The page refuses files over 10 MB up front, matching FormSubmit's limit.

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
