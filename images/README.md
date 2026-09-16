# images/

Photos and renders the page uses, by filename. Replace a file with the same
name and the page picks it up with no code change.

| File | Where it appears | Status |
|---|---|---|
| `DSC01324-3.webp` | Hero, right of the headline. Also the Discord link preview | in |
| `DSC01319-3.webp` | The wide band shot between Parts and Pricing | in |
| `robot-cad.png` | "About us", right of the team paragraph | in |
| `work-01.jpg` | "Photos" — wiring on a machined frame (Mech-a-Mind, FTC #23673) | in |
| `work-02.jpg` | "Photos" — machined side plates on an intake (Mech-a-Mind) | in |
| `work-03.jpg` | "Photos" — Mech-a-Mind in comp | in |
| `work-04.jpg` | "Photos" — Runtime Terror's offseason drivetrain, CAD render | in |

Every figure hides itself if its file is missing, so the page never shows a
broken frame and files can be added one at a time. The `work-*` figures are
a plain `<img>`, not a figure with a fallback — swap one in place to update
it, or add `work-04.jpg` and a fourth `<figure>` in the Photos section for
more.

Export the CAD render on the dark background, not white: the page sits on
near-black and a white render would glare. PNG keeps the edges crisp.

Compress before committing so the page stays quick on venue wifi. A camera
JPEG straight off the card is typically 2000+px wide and several MB —
crop to 4:3, resize to about 1200px wide, and re-export around 80-150KB.
