# images/

Photos and renders the page uses, by filename. Replace a file with the same
name and the page picks it up with no code change.

| File | Where it appears | Status |
|---|---|---|
| `DSC01324-3.webp` | Hero, right of the headline. Also the Discord link preview | in |
| `DSC01319-3.webp` | The wide band shot between Parts and Pricing | in |
| `robot-cad.png` | "About us" — Runtime Terror's 22105, CAD render | in |
| `work-01.jpg` | "Photos" — wiring on a machined frame (Mech-a-Mind, FTC #23673) | in |
| `work-02.jpg` | "Photos" — machined side plates on an intake (Mech-a-Mind) | in |
| `work-03.jpg` | "Photos" — Mech-a-Mind in comp | in |
| `work-04.jpg` | "About us" — Runtime Terror's offseason drivetrain, CAD render | in |
| `asg-viper-1.jpg` | "About us" — All Systems Go's Viper robot, CAD render | in |
| `asg-viper-2.jpg` | "About us" — Viper's drivetrain, CAD render | in |
| `wireframe-22105.png` | Quote PDF footer — Runtime Terror, Canny edge-detect over `work-04.jpg` | in |
| `wireframe-21239.png` | Quote PDF footer — All Systems Go, Canny edge-detect over the Viper drivetrain render | in |

Every figure hides itself if its file is missing, so the page never shows a
broken frame and files can be added one at a time.

**The two `wireframe-*` files** are used only by the quote PDF (`loadPdfArt()`
/ `buildPdf()` in the inline script), not the page itself — white line art on
a dark grey ground, 700×525 (4:3), with the matching team number burned in at
PDF-generation time as outline-only text, not baked into the PNG. To swap one:
keep the same white-on-dark line-art look and roughly the same line density
(`cv2.Canny` on the source render works — see git history for the exact
call), same 4:3 frame. If one fails to load, that side of the footer is
skipped rather than shown broken; if both fail, the whole "OUR TEAMS" block
is skipped.

**Photos** (`work-*`) is real parts and real robots only, grouped by team —
each gets a `.work-team` block with a plain `<img class="frame">` grid. Add a
new `.work-team` block for a team that doesn't have one yet.

**About us** is where each of the three students' own teams gets its number
and two CAD renders, in a `.team-block` (`.team-numbers` for the name/number,
`.team-photos` for the pair of `<figure class="media-cad">`). Most renders are
portrait and use the default aspect ratio; add `media-wide` to the `<figure>`
for one shot landscape instead (the offseason drivetrain, both Viper renders).
A team goes here once it's one of the three founders' own — a customer team's
real photos belong in Photos instead, like Mech-a-Mind's.

Export the CAD render on the dark background, not white: the page sits on
near-black and a white render would glare. PNG keeps the edges crisp.

Compress before committing so the page stays quick on venue wifi. A camera
JPEG straight off the card is typically 2000+px wide and several MB —
crop to 4:3, resize to about 1200px wide, and re-export around 80-150KB.
