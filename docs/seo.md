# Being found

How the published site presents itself to search engines, link unfurlers and the crawlers that
feed language models. `vite/seo.ts` is the plugin; this is the reasoning behind it.

Coda's problem is not that people who try it bounce off — it is that the people it would help do
not know it exists. Nothing here changes the app.

## What was there before, and what the audit found

Four static HTML entries on GitHub Pages at `https://coda.science`, each with a `<title>` and a
`<meta name="description">`. That was the whole of it: no `robots.txt`, no `sitemap.xml`, no
`rel=canonical`, no Open Graph or Twitter card tags, no social image, no structured data, no 404
page.

Two findings mattered more than any of that:

- **The root URL — the one everybody links — had no crawlable text at all.** `index.html` was
  `<div id="root">` and a module script. Not a heading, not a sentence.
- **The node guide's prose was in the DOM one node at a time.** `nodes.html` ships an empty
  `#groups`; `main.ts` fills it with *labels* after load, and the paragraph explaining what a node
  does enters the document only when somebody clicks its tile. The page's whole substance — 97
  entries of "what this takes, what it hands on, when you would reach for it" — was in the shipped
  file nowhere.

Google renders JavaScript and would have found both eventually. **Nothing else does**: not Bing's
fast path, not a single link unfurler, and not one of the crawlers that feed language models —
which for a research tool is now a first-class way of being found, since "which browser tool reads
neuPrint" gets asked of an assistant about as often as of a search box. Adding a sitemap to a site
whose pages are empty until a renderer runs is decorating the front of a shop with the lights off,
which is why the static content came first and the file the ask started with came second.

## The static content

**`index.html` gets a `<noscript>` hero** — an `h1`, what Coda is, which backends it reads, and
links to the three document pages. `noscript` rather than markup inside `#root`, because
`createRoot().render()` clears the container: a static hero in there is a flash of unstyled
content on every load, paid by every real visitor, to serve a crawler. It is also the honest
version of the claim, since it *is* what the page offers with no script. Its styles are inline
attributes: the app's stylesheet is a `<link>` in a production build and JavaScript-injected in
dev, so a class-based version would be right in one and unstyled in the other.

**`nodes.html` gets a static index**, `src/nodeguide/appendix.ts`, spliced into the file at build
time in place of a `<!--@node-appendix-->` marker. It is **visible, real content** at the foot of
the page — not hidden text keyed to a crawler, which is cloaking and deserves the penalty it
earns. It happens to be a form somebody genuinely wants and the grid cannot be: every node's name,
signature, cost and paragraph in one page, readable straight through, printable, and findable with
the browser's own find.

It renders through the same machinery the guide already used — `vite/nodeGuideData.ts` runs
`appendixHTML()` on its SSR server beside the registry dump, so nothing is committed, nothing can
drift, and a node added next month appears with no one opening `src/nodeguide`. The module imports
`./data` and therefore the whole 660 kB registry, which is exactly why it never reaches the
browser. `SECTIONS` and `CAT_LABEL` moved to `src/nodeguide/sections.ts` when this arrived, so the
grid and the index answer "which section is Normalize in" from one table.

**Measured cost:** `dist/nodes.html` goes from 5.4 kB to 87.8 kB raw, 2.1 kB to 22.2 kB gzipped.
`nodes-*.js` is unchanged at 198.8 kB — confirmed by building both ways, and the thing to check
after any edit here, since an accidental import of `appendix.ts` from `main.ts` would show up
there and nowhere else.

## The tags

`vite/seo.ts` injects per page, deriving the page list from `build.rollupOptions.input` so a fifth
entry cannot arrive with no canonical and no sitemap row — the rule `vite/goatcounter.ts`
established for the same reason.

- **`rel=canonical`**, absolute. The editor canonicalises to `/`, not `/index.html`.
- **Open Graph and Twitter cards**, with `summary_large_image`.
- **JSON-LD.** The editor is a `SoftwareApplication`; the three documents are `WebPage`s that name
  the app's `@id` in `about`, so a crawler reading all four resolves them to one entity rather than
  to four documents that share a domain.

**Titles and descriptions are read off each page rather than kept in a table in the plugin.** Every
entry already carries both, written for that page. A second copy is a second spelling, and the one
that drifts is the one nobody sees — `og:description` is invisible until it is wrong in somebody
else's timeline.

### The titles are query-shaped, not brand-shaped

They used to be `Coda Overview`, `Coda Field Guide`, `Coda Node Guide`. Each spent its whole
title tag — the strongest on-page signal there is — on a word with no search volume, because
nobody searches for `Coda`: not knowing it exists is the problem this file is about. They now read
`Coda <page> — <what somebody would actually type>`:

| | |
|---|---|
| `/` | Coda — Connectome Data Analysis in the Browser |
| `/overview.html` | Coda Overview — connectome analysis for neuPrint, CAVE, CATMAID |
| `/tutorial.html` | Coda Field Guide — build a connectome analysis pipeline |
| `/nodes.html` | Coda Node Guide — every dataset, query, transform and viewer |

Three rules held them to that shape. **The brand goes first**, because Google truncates around 60
characters and cuts the *tail* — a title front-loaded with query terms loses its own name on the
results page. **All four stay under 60**, which is why the overview names three backends and not
five. And **they must differ from each other in the first few words**: four titles opening `Coda —`
read as one page duplicated, which is a thing Google actively discounts.

`og:title`, `twitter:title` and the JSON-LD `name` all follow automatically, since the plugin reads
them off the page.

The root page's **description** was rewritten on the same reasoning. It read `Node-graph analysis
pipelines for connectomic data.` — 51 characters where Google shows about 155, so the most
important page in the set was throwing away two thirds of its snippet.

It has since been rewritten once more, for a reader the first pass did not have in mind. It now
reads:

> A scientific web application for browser-based analysis and visualisation of public connectome
> data: neuPrint, CAVE (FlyWire, MICrONS) and CATMAID.

147 characters, with the weight in the first 120 because that is where a phone truncates. What
changed and why: a search engine wants the backends by name, since those are the words somebody
types, and the previous copy was written for that reader alone. But this field is also close to
the *only* thing the engines that categorise a domain — is this a research tool, or a parked page,
or something to be filtered — have to go on, and for them the load-bearing words are `scientific`,
`web application` and above all **`public`**. Coda reads published connectome data; a description
that does not say so leaves somebody vetting the domain to guess, and the guess is not reliably
generous. One sentence now carries both readers, institutional framing first and backends second.
The cost is `No install, no code`, which did not fit and which the `<noscript>` hero says anyway.

The other three pages' descriptions were already the right length and say the right things.

**Each of the four is pinned onto one line by a `<!-- prettier-ignore -->`,** which is not
cosmetic. Prettier wraps a `<meta>` past its print width across four lines, and at that point the
string `meta name="description"` does not appear in the file at all — so the ordinary hand-check,
`curl -s https://coda.science/ | grep 'meta name="description"'`, reports the tag missing on a
page that has always had one. That is how it was actually read: every real consumer parses HTML
and was perfectly happy, including `pageText` in the plugin, whose regex uses `\s+` between the
attributes. A false negative only a human hits is still a false negative, and the people who
hand-check this page are the ones whose opinion of the domain is being formed.

**`manifest.webmanifest` deliberately did *not* follow, in either field.** Its `name` is the label
under an installed app's icon, where a search-shaped title is simply too long; `short_name` is
`Coda` and the full name stays the plain expansion. Its `description` is read in an install prompt
by somebody who has already decided, so it is not competing for a click and has no reason to carry
backend names. Both look like they should agree with the page and are answering a different
question — which is why the divergence is recorded here rather than left to look like drift. Same for the `document.title` fixture in `src/ui/notify.test.ts`, which is
about `flashTitle` restoring whatever it captured and does not care what the string is.

## The design notes do not ship

The entry documents carry their reasoning inline, next to the tag it explains — the convention the
rest of the repo follows. What nobody checked is that **vite does not strip HTML comments**. All of
it was being served.

The measurement, before the fix:

| page | total | comment prose |
| --- | ---: | ---: |
| `index.html` | 6,225 B | 3,338 B (54%) |
| `overview.html` | 45,603 B | 3,572 B |
| `tutorial.html` | 44,387 B | 2,450 B |
| `nodes.html` | 5,764 B | 951 B |
| `public/404.html` | 3,806 B | 1,401 B (37%) |

Run the naive text extraction a reviewer reaches for — `sed 's/<[^>]*>//g'` — and the root page
yielded 5,402 characters, most of them working notes. It is not a payload problem at that size; it
is a first-impression problem, and it was reported as one. The same text is what a text-extracting
crawler takes for page content, which is precisely the audience the `<noscript>` block above exists
to serve properly. After stripping, that extraction yields 2,086 characters and all of it is the
hero.

`vite/stripComments.ts` has the reasoning; the one decision worth repeating here, because it is
about this document's own subject, is **why it is a sweep of `dist/` rather than a
`transformIndexHtml` hook**. The hook fires once per `build.rollupOptions.input` entry — so the
first version of this covered exactly the four pages that appear in `PAGES` above and silently
missed `public/404.html`, which is copied byte-for-byte. That page is what GitHub Pages serves for
every mistyped and every rotted link, so it meets more strangers per visit than `nodes.html` does,
and it was still 37% design notes while the check reported four of four clean. A hook keyed to the
entry list can only state "no *entry* carries design notes". The invariant worth having is
"nothing we publish does", and the only place that is true is the directory about to be uploaded —
which also means no page list to keep, where the two plugins above both keep one.

## The social image

`public/og.png`, 1200×630, cut from `scripts/og-card.svg` with `pnpm og:card` (rsvg-convert). PNG
because it is the only format every unfurler reads — an SVG in `og:image` is ignored by all of
them. The card carries its own palette as literals, since it renders on somebody else's surface
with no stylesheet, and the values are theme.css's **dark** block so following the link does not
go from a light card to a dark app. The type is set rather than cut to paths, which is a trade:
the PNG is committed, so the font resolution happens once on whoever regenerates it. Check the
result by eye afterwards — a substitution shows as a line running out of the left half into the
node cards.

## `robots.txt` and `sitemap.xml`

Both emitted by the plugin rather than committed to `public/`, so `SITE_URL` has one spelling and
the sitemap's page list *is* the build's entry list.

**`lastmod` comes from git, or it is omitted** — the newest commit touching that page's sources,
where "sources" is wider than the entry file (the node guide's text is the node registry). A wall
clock would restamp all four pages on every deploy, telling a crawler four documents changed when
none did, and a source that lies about `lastmod` is one Google stops reading it from. Absent is a
fact; false is worse than nothing. This is why `deploy.yml` now checks out with `fetch-depth: 0`.

No `changefreq` and no `priority`: ignored by Google for years, never read by Bing, and noise in a
file whose only value is that it is trustworthy.

**Everything is allowed, AI crawlers included.** That is a decision, not a default. There is
nothing here to protect — four public documents in a public, MIT-licensed repository, and no user
content, since a workflow lives in the URL fragment and no crawler ever sees one. The upside is the
discovery channel described at the top. If that judgement ever changes, the block goes in
`vite/seo.ts` and nowhere else.

## `SITE_URL`, and what a fork gets

`https://coda.science` by default, overridable with `CODA_SITE_URL`, which may carry a path
(`https://x.github.io/coda`).

This is deliberately **not** gated the way `CODA_ANALYTICS` is, and the difference is worth being
precise about. The analytics gate exists because a fork's *readers* would otherwise be reported to
a dashboard its operator never chose: a third party acquires data about people who did not agree
to it. Nothing here leaves the deployment. The worst case is that a fork which deploys elsewhere
and sets nothing tells search engines the canonical copy is at coda.science — a consequence
contained entirely within that fork, and for an unmodified one arguably the right answer. Setting
`CODA_SITE_URL` fixes it in one line.

One thing a subpath deployment does not get: `robots.txt` is only read at a host root, so a build
at `https://x.github.io/coda/` ships the file and no crawler reads it. The tags and the sitemap
still work.

## The 404 page

`public/404.html`, copied verbatim rather than being a fifth vite entry — GitHub Pages serves it
for anything it cannot resolve, and without it a rotted link to coda.science lands on GitHub's own
page, which carries their branding and no way back into the site.

`<meta name="robots" content="noindex, follow">` is the load-bearing tag: a 404 body served under
a URL that looks like a real page is how a soft-404 gets indexed, and an indexed error page
competes with the pages that should rank.

Its links are the one place in this repository that are **absolute**, inverting the rule the four
entries follow. They are relative everywhere else because `base` is `'./'` and the site has to work
from a subpath; this page is served for a request at *any* depth, so a relative href would resolve
against a directory that does not exist and the way out of a 404 would itself 404.

## What is deliberately not done

- **No prerendering of the editor.** The app is the app; `noscript` is the right size of answer.
- **No `hreflang`, no `WebSite` `searchAction`.** One language, and the site has no search
  endpoint to declare — a sitelinks searchbox that does not work is a worse result than none.
- **No per-node URL.** The node guide is one page with an anchor per node
  (`#node-neuron-connectivity`); 97 thin pages would compete with each other and with the page
  that should rank.
- **No analytics event tracking to measure any of this.** Unchanged from
  [analytics.md](analytics.md), and for the reason stated there: GoatCounter counts page loads,
  and what somebody builds on the canvas is not ours to watch. Whether this worked is answered by
  the four pinned paths already on the dashboard, and by Search Console if somebody verifies the
  domain.

## Checking it

`pnpm build`, then:

```bash
cat dist/robots.txt dist/sitemap.xml
grep -c 'class="entry"' dist/nodes.html      # must equal the listable node count
grep -o 'rel="canonical" href="[^"]*"' dist/*.html
grep -c -- '<!--' dist/*.html                 # 0 each, 404.html included
grep -c 'meta name="description"' dist/*.html # 1 each; 404.html has none and needs none
```

Both of those have been wrong in a deployed build while the source read correctly, which is why
neither is only a checklist item: `stripComments` guarantees the first by construction, and warns
during the build if a page carries a description the second cannot find.

`src/nodeguide/appendix.test.ts` asserts coverage against the real registry and the escaping;
`nodeGuide.test.ts` continues to assert that every node has a paragraph worth printing. The
appendix's multi-column flow was driven in a real browser at 1440px and 420px, on the standing
every other page in that directory has.

After deploying: submit `https://coda.science/sitemap.xml` in Google Search Console and Bing
Webmaster Tools once, and check one link preview per network — a card that renders in Slack can
still fail in Bluesky, which fetches the image itself.
