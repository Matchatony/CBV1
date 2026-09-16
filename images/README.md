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
| `work-04.jpg` | "About us" — Runtime Terror's offseason drivetrain, CAD render | in |
| `asg-viper-1.jpg` | "Photos" — All Systems Go's Viper robot, CAD render | in |
| `asg-viper-2.jpg` | "Photos" — Viper's drivetrain, CAD render | in |

Every figure hides itself if its file is missing, so the page never shows a
broken frame and files can be added one at a time. The `work-*` and
`asg-*` figures in Photos are a plain `<img>`, not a figure with a fallback —
swap one in place to update it, or add another and a matching `<figure>`
inside that team's `.work-team` block for more. Photos is grouped by team —
add a new `.work-team` block for a team that doesn't have one yet. It's real
parts and robots only in general, but CAD renders are fine there when a team
doesn't have finished-robot photos yet (as with All Systems Go's Viper); CAD
for a team that also has real photos still goes in About us instead, like
`work-04.jpg` there.

Export the CAD render on the dark background, not white: the page sits on
near-black and a white render would glare. PNG keeps the edges crisp.

Compress before committing so the page stays quick on venue wifi. A camera
JPEG straight off the card is typically 2000+px wide and several MB —
crop to 4:3, resize to about 1200px wide, and re-export around 80-150KB.
