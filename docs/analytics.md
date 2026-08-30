# Analytics

Coda counts page views. This document is what it collects, what it does not, and why each
decision went the way it did.

The short version: [coda-science.goatcounter.com](https://coda-science.goatcounter.com/) is
public. Anything said here can be checked against the dashboard itself, which is the point of
publishing it.

## Why there is a beacon at all

The site is a static bundle on GitHub Pages. There are no server logs to read and no way to get
any — GitHub does not expose them — so the choice is not "beacon or logs", it is "beacon or
nothing". Nothing was the state until now, and it makes three ordinary questions unanswerable:
whether anyone opens the editor, which of the four pages they actually read, and how they
arrived.

Those are the only three questions this is here to answer.

## Why GoatCounter

It answers them without acquiring anything about the person. Verified against their own
documentation and against `count.js` itself:

- **No cookie, no `localStorage`, no cache entry, no tracker id.** Nothing is written to the
  browser at all.
- **No stored IP and no stored full User-Agent.** A session is `site + IP + User-Agent` held *in
  memory* for up to 8 hours and mapped to a random string; the random string is what reaches the
  database.
- **Aggregates, not a log of you.** Browser, OS, country, screen width, referrer, path.
- **Open source and self-hostable**, so the escape hatch if the hosted service goes away is real
  rather than notional.

GoatCounter's own position is that a consent banner is probably not required — no personal data,
plus legitimate interest — with the honest caveat that they are not lawyers. That reasoning is
theirs to make; ours is that a banner asking permission to increment a counter is worse for the
reader than the counter is.

**The tradeoff being accepted**: goatcounter.com is one maintainer, free for reasonable use,
donation-funded, no SLA. Treat it as disposable rather than as infrastructure. Losing it costs a
number nobody is making decisions with.

## What is deliberately *not* collected

**No events, and no instrumentation of the canvas.** It would be easy to count which nodes get
added, and it is the obvious next request. It is not going in. Counting page loads and observing
what somebody *builds* are different propositions, and the second one contradicts what
`SourcesPanel` tells every user four times over — that their credentials, their graph and their
data stay in this browser. A pipeline is a research question before it is published. It is not
ours to watch.

## Four decisions in `vite/goatcounter.ts`

Each is silent when wrong, which is why they are written down.

**The tag exists only in a deploy build.** `apply: 'build'` keeps it out of `pnpm dev`, and
`CODA_ANALYTICS` — set in [deploy.yml](../.github/workflows/deploy.yml) and nowhere else — keeps
it out of every other build. The second gate is the load-bearing one: this repository is public
and permissively licensed, so somebody will fork and host it. Without the gate their traffic
lands in our dashboard, which corrupts the numbers and, much worse, reports *their* readers to a
third party their operator never chose. An unset variable has to be the safe default.

**The path is pinned, never read off the address bar.** GoatCounter's default path is
`location.pathname + location.search`. The fragment is excluded, and a Coda share link carries
the whole workflow in the fragment (`#!gh://…`, or the packed graph) — so nothing leaks today.
That is a fact about how sharing currently works, not a promise about it. The day a query
parameter appears anywhere in the app, its contents would silently become analytics data.
Sending a literal per entry closes that off before it can happen, and reads the same on the
dashboard wherever the site is mounted — Pages serves from `/coda/`, and `/overview` does not
care.

The literal is derived from the entry filename rather than looked up in a table, so a fifth
entry added to `build.rollupOptions.input` cannot arrive unlabelled or fall back to the default:

| entry            | path        |
| ---------------- | ----------- |
| `index.html`     | `/editor`   |
| `overview.html`  | `/overview` |
| `tutorial.html`  | `/tutorial` |
| `nodes.html`     | `/nodes`    |

`index.html` is `/editor` rather than `/` because a `/` sitting above `/overview` in a list of
four reads as their total.

**Settings go on `window.goatcounter`, not `data-goatcounter-settings`.** The attribute takes
JSON and vite serialises attribute values into double quotes without escaping the ones inside,
so the attribute form emits a broken tag. `count.js` opens with
`window.goatcounter = window.goatcounter || {}` and merges the data attribute *over* it, so
setting the global in an inline script first is both documented upstream and safe from being
clobbered.

**`pnpm preview` does not count, and not because of our gate.** `count.js` filters `localhost`,
the private IPv4 ranges, `0.0.0.0`, `file:`, prerendered documents and framed pages on its own.
Worth knowing because it means the local-safety property survives the `CODA_ANALYTICS` gate
being changed.

## Opting out

`count.js` checks `localStorage` for `skipgc` before sending anything. In the browser console,
on any Coda page:

```js
localStorage.setItem('skipgc', 't')
```

That browser stops being counted, permanently, with no account and nothing to undo elsewhere.
An ad blocker or Do Not Track set to block third-party scripts also works — `gc.zgo.at` is on
the common lists, and a blocked beacon is simply a page view that does not happen.

## Where the dashboard link appears

Four places, so that no surface says something about the site without also saying this:

- the start page credits row (`StartPage.tsx`, beside Overview / Docs / Node guide)
- the colophon on `overview.html` and `tutorial.html`
- the meta row on `nodes.html`
- [README.md](../README.md)

If the counter is ever removed, those four go with it.
