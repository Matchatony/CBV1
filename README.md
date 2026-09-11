# Crackbotics

One-page marketing site and a print-ready flyer for Crackbotics — custom CNC
aluminum parts for FTC teams.

Plain HTML and CSS. No build step, no dependencies, no framework. Open the
files in a browser and they work; drop the folder on a host and it's live.

```
crackbotics/
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
| `https://discord.gg/YOUR-INVITE` | `index.html` (2x), `flyer.html` (6x — one per tear-off tab) |
| `hello@crackbotics.com` | `index.html` (4x), `flyer.html` |
| `crackbotics.com` | `flyer.html` |
| QR code box | `flyer.html` — see below |
| Product photos | `index.html` — see below |

```sh
# quick pass over both files
sed -i 's|discord.gg/YOUR-INVITE|discord.gg/abc123|g' index.html flyer.html
```

Use a **non-expiring** Discord invite. A flyer outlives a 7-day link.

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
   - **Build output directory:** `crackbotics`
4. Save and Deploy. You get `your-project.pages.dev` in about a minute.
5. Custom domain: Pages → your project → Custom domains → add `crackbotics.com`.
   If the domain is registered at Cloudflare, DNS is automatic.

Every push to your default branch redeploys.

### GitHub Pages

This folder lives inside a larger repo, so Pages needs a workflow to publish
just this subdirectory. Move the included file into place:

```sh
mkdir -p ../.github/workflows
git mv github-pages.yml ../.github/workflows/pages.yml
```

Then in the repo: Settings → Pages → Source: **GitHub Actions**. Push, and the
site lands at `https://<user>.github.io/<repo>/`.

Note the trailing-slash path — all links here are relative, so it works from a
subpath without changes. For a custom domain, add a `CNAME` file next to
`index.html` containing just your domain.

### Testing locally

```sh
python3 -m http.server 8000     # then open http://localhost:8000/crackbotics/
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
