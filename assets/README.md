# Source assets

Masters for images that ship in a derived form. Kept in the repository so the
shipped asset can be regenerated rather than recreated by eye.

| File | Produces | How |
| --- | --- | --- |
| `og.png` (1731×909) | `public/og.jpg` (1200×630, ~120KB) | `npm run og` |

**Why the share card is a JPEG.** The artwork is a photographic render, so JPEG
costs ~120KB where the equivalent PNG costs ~548KB. That matters: WhatsApp skips
link previews for images much beyond a few hundred kilobytes, so the heavier file
would simply not appear for a large share of recipients.

**Why 1200×630 exactly.** It is the size `app/layout.tsx` declares in
`og:image:width` / `og:image:height`, and the ratio every platform lays out for.
Shipping a different size than the one declared makes scrapers reserve the wrong
space. The master's own ratio is 1.904 against the target 1.905, so the resize is
imperceptible.
