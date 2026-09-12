#!/usr/bin/env node
/**
 * The Dataset Guide's specimen tabs, measured. `pnpm probe:dataset-tabs`.
 *
 * ## Why this exists
 *
 * The tab strip is a radio group and a `:has()` rule — there is no JavaScript behind it, which
 * is what lets the page keep its "no client renderer" property. The consequence is that nothing
 * in the vitest suite can see whether it *works*: jsdom matches no `:has()` selector, computes
 * no layout, and answers `null` for `offsetParent` on every element including the visible ones.
 * So `datasetGuide.test.ts` pins what a string can pin — that a tab exists per clade, that a
 * rule was generated for it, that every row carries a `data-clade`, that exactly one radio opens
 * checked — and this pins the half only a browser knows:
 *
 *   - **each tab shows exactly the rows it counts**, which is the whole feature and which fails
 *     silently if a generated selector and a row attribute disagree by one character;
 *   - **All shows every row**, so the default state is the full table;
 *   - **the radios are focusable**, since the inputs are visually hidden and the clip pattern is
 *     one `display: none` away from dropping the control out of the tab order entirely;
 *   - **the document never gets wider than the viewport**, the property `probe-mobile.mjs`
 *     established for the app and which a table in a scroller can break at any width.
 *
 * ## The wait is on the stylesheet, not on the markup
 *
 * Every row of this table is in the html from the first byte — that is the point of the page —
 * so waiting for one lets a measurement through before any CSS has applied. In dev the
 * stylesheet arrives with the module, and the unstyled table has no `overflow-x` container: the
 * first read at 412px was **613px of document against a 412px viewport**, a horizontal-overflow
 * failure that was entirely the probe's own. It waits for a computed style the stylesheet is the
 * only source of instead. Same trap `probe-node-anatomy.mjs` records from the other side, where
 * the markup is static and the *measurement* is what has to have happened.
 *
 * ## How
 *
 * Chrome over the DevTools protocol against whatever is being served. Needs `pnpm dev --port
 * 5177` — the port the other browser probes ask for — or a `--url`.
 *
 *   pnpm probe:dataset-tabs
 *   pnpm probe:dataset-tabs -- --url http://localhost:4173/datasets.html
 *   pnpm probe:dataset-tabs -- --keep
 *
 * `--keep` writes a screenshot per tab. Exit code is 1 if any property fails.
 */

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const URL = args.value('--url') ?? 'http://localhost:5177/datasets.html'

/** Wide enough for the table's own `min-width`, and one phone width. */
const WIDTHS = [1440, 900, 412]

/**
 * Read the strip and the table in one evaluation.
 *
 * `offsetParent === null` rather than `getComputedStyle(...).display`: the rule hides a `<tr>`,
 * and asking the row's own computed style would answer for the row while saying nothing about
 * an ancestor that might also be hidden.
 */
const MEASURE = `(() => {
  const tabs = [...document.querySelectorAll('.tabs__input')].map((input) => ({
    id: input.id.replace(/^clade-/, ''),
    checked: input.checked,
    count: Number(
      document.querySelector(\`label[for="\${input.id}"] .tabs__n\`)?.textContent.trim() ?? -1,
    ),
  }))
  const rows = [...document.querySelectorAll('.compare__table tbody tr')]
  return {
    tabs,
    stripShown: !!document.querySelector('.tabs')?.offsetParent,
    visible: rows.filter((r) => r.offsetParent !== null).length,
    total: rows.length,
    docWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }
})()`

const page = await launchChrome({
  port: 9353,
  profile: '/tmp/coda-dataset-tabs-profile',
  width: WIDTHS[0],
  height: 1000,
})
const report = probeReport()

for (const width of WIDTHS) {
  console.log(`\n— ${width}px —`)
  await page.setDevice(width, 1000, 1)
  await page.send('Page.navigate', { url: URL })
  await page.waitFor(`!!document.querySelector('.compare__table tbody tr')`, 'the table')
  /* See the header: the rows are static, the stylesheet is not, and an unstyled table has no
     scroller around it. `overflow-x` is `.compare__scroll`'s and nothing else sets it. */
  await page.waitFor(
    `getComputedStyle(document.querySelector('.compare__scroll')).overflowX === 'auto'`,
    'the stylesheet',
  )

  const first = await page.evaluate(MEASURE)

  report.check(first.stripShown, 'the tab strip is drawn')
  report.check(
    first.tabs.filter((t) => t.checked).length === 1 && first.tabs[0]?.checked === true,
    'exactly one tab opens checked, and it is All',
  )
  report.check(
    first.visible === first.total,
    `All shows every row (${first.visible}/${first.total})`,
  )
  report.check(
    first.docWidth <= first.viewport,
    `the document is no wider than the viewport (${first.docWidth} / ${first.viewport})`,
  )

  for (const tab of first.tabs) {
    await page.evaluate(`document.getElementById('clade-${tab.id}').click()`)
    const m = await page.evaluate(MEASURE)
    const want = tab.id === 'all' ? m.total : tab.count
    report.check(
      m.visible === want,
      `${tab.id}: shows ${m.visible} rows, tab says ${want}`,
    )
    report.check(
      m.docWidth <= m.viewport,
      `${tab.id}: no horizontal overflow (${m.docWidth} / ${m.viewport})`,
    )
    if (args.keep) console.log(`  ${await page.screenshot(`dataset-tabs-${width}-${tab.id}`)}`)
  }

  /*
   * The inputs are hidden with the clip pattern rather than `display: none`, and the difference
   * is invisible until somebody tries to reach the strip from the keyboard.
   */
  await page.evaluate(`document.getElementById('clade-all').focus()`)
  report.check(
    (await page.evaluate(`document.activeElement?.id`)) === 'clade-all',
    'a hidden radio still takes focus',
  )
}

page.close()
report.finish('Run `pnpm dev --port 5177` first, or pass --url.')
