/**
 * The body of a `CAVE table info` node: what one table of a datastack actually is.
 *
 * Everything on this card is *scalar* — a schema type, two counts, a description — which is
 * exactly why it is a card rather than a second output socket. A property/value table would be a
 * table whose rows have nothing to do with each other, and the one thing here worth reading at
 * length is prose, which does not survive being a cell. The columns are the half that *is* tabular
 * and they go out on the wire.
 *
 * Drawn from `peekTableFacts` — the synchronous cache the node's `evaluate` also reads — so the
 * card fills as soon as a real table name is typed, without a Run, the way `DescriptionBody` fills
 * from `peekDataset`. What that peek deliberately does **not** do is query: a column sample
 * against an aggregating view can take minutes and belongs behind a Run with a Cancel button. See
 * `data/cave/tables.ts`.
 *
 * The description is rendered through `MarkdownView` for the reason every stranger's text is:
 * every node becomes a React element, so a blurb from whatever deployment a Custom CAVE node
 * points at can never introduce markup, and the extended kinds stay off.
 */

import type { CaveTableFacts } from '../../data/cave/tables'
import { kindOf, peekTableFacts, peekTableList } from '../../data/cave/tables'
import { caveDatastackIssues, caveTargetOfType } from '../../nodes/lib/caveParams'
import { formatNumber } from '../format'
import { MarkdownView } from '../MarkdownView'
import type { CodaType } from '../../core/types'
import type { NodeBodyProps } from './nodeBodies'

export function CaveTableInfoBody({ node, ctx, compact }: NodeBodyProps) {
  const params = node.params
  /*
   * Through the node's own resolver, not a second reading of the same two params. The card used
   * to spell the wire-beats-field rule itself (`splitDatasetId(wired ?? typed)`), which trims
   * differently — so a partly-resolved Dataset could have the card describing one datastack while
   * the run read another.
   */
  const where = caveTargetOfType(ctx.inputs.dataset, params)
  const name = String(params['table'] ?? '').trim()

  const facts = where ? peekTableFacts(where.datastack, where.version, name) : undefined
  if (!facts) {
    return <p className="cave-info__empty">{absence(ctx.inputs.dataset, params, where, name)}</p>
  }

  return (
    /* `nowheel` so a long description scrolls under the pointer instead of zooming the canvas. */
    <div className="cave-info nodrag nowheel">
      <div className="cave-info__head">
        <span className="cave-info__name" title={facts.name}>
          {facts.name}
        </span>
        <span className="cave-info__kind" title={kindTitle(facts.kind)}>
          {facts.kind}
        </span>
        {facts.schemaType && (
          <span
            className="cave-info__schema"
            title="The registered emannotationschemas type — what shape a row of this table is"
          >
            {facts.schemaType}
          </span>
        )}
      </div>

      {/*
       * The publisher's own warning, and the only thing on this card with a colour. `notice_text`
       * is null on every table probed, so a table that sets it is saying something it went out of
       * its way to say — a deprecation, a caveat about the annotations. Rendering it like every
       * other row would bury it under the description.
       */}
      {facts.notice && <p className="cave-info__notice">{facts.notice}</p>}

      <dl className="cave-info__rows">
        {facts.rows !== undefined && (
          <Row
            label="rows"
            value={formatNumber(facts.rows)}
            /*
             * Both counts are labelled, and this is the reason the card carries two at all: they
             * disagree by up to a third and each answers a different question. See
             * `materializedCount` in `data/cave/api.ts` for the measured table.
             */
            title="The annotation service's count — the table as it stands now, across every materialization. This is the one that predicts whether a query hits CAVE's 500,000-row cap."
          />
        )}
        {facts.materializedRows !== undefined && where && (
          <Row
            label={`in v${where.version}`}
            value={formatNumber(facts.materializedRows)}
            title={`How many rows materialization ${where.version} froze. Lower than the live count wherever rows were dropped from the snapshot, which is usual rather than a fault.`}
          />
        )}
        {facts.referenceTable && (
          <Row
            label="annotates"
            value={facts.referenceTable}
            title="A reference table: its target_id joins to that table's id rather than carrying a root id of its own."
          />
        )}
        {facts.voxelResolution && (
          <Row
            label="resolution"
            value={`${facts.voxelResolution.join(' × ')} nm`}
            title="Nanometres per unit of this table's stored positions. Shown only where it is not already 1:1."
          />
        )}
        {!compact && facts.readPermission && (
          <Row
            label="permissions"
            value={`read ${facts.readPermission}${facts.writePermission ? ` · write ${facts.writePermission}` : ''}`}
            title="Who the CAVE deployment lets read and write this table."
          />
        )}
        {!compact && facts.lastModified && (
          <Row
            label="modified"
            value={facts.lastModified.slice(0, 10)}
            title={`Created ${facts.created ?? 'unknown'}, last modified ${facts.lastModified}`}
          />
        )}
      </dl>

      {facts.description ? (
        <MarkdownView source={facts.description} className="cave-info__text" />
      ) : (
        <p className="cave-info__empty">{facts.name} publishes no description.</p>
      )}
    </div>
  )
}

function Row({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <div className="cave-info__row" title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function kindTitle(kind: CaveTableFacts['kind']): string {
  return kind === 'view'
    ? 'A view: a query the datastack saved, usually a join or a roll-up. It has no metadata record and no row count of its own, and a row limit does not push down into one.'
    : 'An annotation table, with a registered schema and a row count.'
}

/**
 * Five absences, said apart.
 *
 * They are five states this card passes through on the way to being filled, and collapsing them
 * would have a card that is about to fill itself look like a card that never will —
 * `DescriptionBody`'s rule, with two more states because there are two fetches rather than one.
 * The listing landing and the facts landing are separate hops, and the message says which one is
 * outstanding so a stall is attributable.
 *
 * **The first two are `validate`'s own sentences, not paraphrases of them.** They used to be
 * reworded here ("Name a datastack as `name:number`…" against "Name a datastack, e.g.
 * flywire_fafb_public:783…"), so one unconfigured node showed two different instructions
 * depending on whether you read the body or the warning strip under it. The last three are
 * states `validate` deliberately has no opinion on — a listing that has not arrived is not a
 * problem to report (invariant 2) — so those are this card's own words.
 */
function absence(
  inputType: CodaType | undefined,
  params: Record<string, unknown>,
  where: { datastack: string; version: number } | undefined,
  name: string,
): string {
  const issue = caveDatastackIssues(inputType, params)[0]
  if (issue) return `${issue}.`
  if (!where) return 'Waiting for the wired Dataset to name a datastack.'
  if (!name) return 'Name a table or a view. List CAVE tables is where the names come from.'
  const entries = peekTableList(where.datastack, where.version)
  if (!entries) return `${where.datastack}:${where.version} has not listed its tables yet.`
  if (!kindOf(entries, name)) {
    return `${where.datastack}:${where.version} publishes no "${name}".`
  }
  return `Reading ${name}…`
}
