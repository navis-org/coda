/**
 * The Annotate card: a tab per target, each with its settings, a chooser for which of its fields to
 * show, and a table of the neurons routed to it where editing a cell writes it back.
 *
 * Everything that touches a backend is here and nowhere in the node (`packs/annotation/editor.ts`).
 * A tab is `useTargetTable` once — its reads, writes, marks and undo — and `AnnotateTable`. The card
 * routes each incoming neuron to the tabs whose `serves` names its dataset, and says how many no tab
 * serves. The log and the undo history are the card's, shared by its tabs; each tab's Undo takes
 * back its own table's last change.
 */

import { Fragment, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import { idText } from '../../core/ids'
import type { InferContext, ParamDef } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import { isTableValue, tableFromRows } from '../../core/values'
import { annotationTarget } from '../../data/annotations/targets'
import {
  editableFileState,
  grantEditableFile,
  holdEditableFile,
} from '../../data/files/editable'
import type { RememberedState } from '../../data/files/remembered'
import { subscribeUploadLearned } from '../../data/uploads'
import { errorMessage } from '../../core/errors'
import { clioDatasets, clioListingKey } from '../../data/annotations/targets/clio'
import { literalText } from '../../data/annotations/targets/fieldValues'
import { routeToTargets, servedDatasets } from '../../packs/annotation/routing'
import type {
  Backend,
  SpecBoolKey,
  SpecTextKey,
  TargetSpec,
} from '../../packs/annotation/targets'
import {
  newSpec,
  readSpecs,
  specConfig,
  specEffects,
  specLabel,
  writeSpecs,
} from '../../packs/annotation/targets'
import { useGraphStore } from '../../store/graphStore'
import { downloadCsv, exportBaseName, tableToCsvParts } from '../export'
import { plural } from '../../style/format'
import { ParamField, TextField } from '../params/ParamField'
import { cardParams } from '../params/paramGroups'
import { useSettledFetch } from '../viewers/useSettledFetch'
import { scopedKey } from '../viewers/workflowScope'
import { AnnotateTable, FieldChooser, FillBar } from './AnnotateTable'
import { useAnnotateSession } from './annotateSession'
import type { NodeBodyProps } from './nodeBodies'
import type { Rows } from './useTargetTable'
import { useTargetTable } from './useTargetTable'

/** Rows drawn on the canvas card; the overlay draws them all. */
const CARD_ROWS = 40

const NO_STORED: readonly string[] = []

export function AnnotateBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)
  const value = useGraphStore((s) => s.nodeInputs(node.id)['neurons'])
  const locked = useGraphStore((s) => s.locked)
  const workflow = useGraphStore((s) => s.activeTabId)
  const graphName = useGraphStore((s) => s.graph.meta?.name)
  const session = scopedKey(workflow, node.id)
  const { log } = useAnnotateSession(session)

  const stored = (node.params.targets as readonly string[] | undefined) ?? NO_STORED
  const specs = useMemo(() => readSpecs(stored), [stored])
  const setSpecs = (next: readonly TargetSpec[]) => setParam('targets', writeSpecs(next))
  const [active, setActive] = useState(0)
  const index = Math.min(active, specs.length - 1)

  // The incoming neurons, and each tab's share of them.
  const idColumn = ctx.column('idColumn')
  const datasetColumn = ctx.column('datasetColumn')
  const incoming = useMemo(() => {
    if (!isTableValue(value) || !idColumn || !(idColumn in value.data)) return undefined
    return {
      ids: value.data[idColumn]!.map((cell) => idText(cell)),
      datasets: datasetColumn
        ? value.data[datasetColumn]?.map((cell) => (cell === null ? null : String(cell)))
        : undefined,
    }
  }, [value, idColumn, datasetColumn])
  // Keyed on what routing reads, so choosing a field or ticking a setting does not re-route.
  const serves = JSON.stringify(specs.map((s) => s.serves))
  const routing = useMemo(
    () =>
      incoming &&
      routeToTargets(
        incoming.ids,
        incoming.datasets,
        (JSON.parse(serves) as string[]).map(servedDatasets),
      ),
    [incoming, serves],
  )

  const exportLog = () => {
    const header = [
      'time',
      'target',
      'neuronId',
      'row',
      'field',
      'before',
      'after',
      'outcome',
      'message',
    ]
    const table = tableFromRows(
      tableSchema(...header.map((name) => column(name, 'str'))),
      log.map((e) => ({
        time: e.at.toISOString(),
        target: e.label,
        neuronId: e.id,
        row: e.key,
        field: e.field,
        before: literalText(e.before),
        after: literalText(e.after),
        outcome: e.outcome,
        message: e.message ?? '',
      })),
    )
    downloadCsv(
      tableToCsvParts(table),
      `${exportBaseName(graphName, node.title ?? 'annotate')}-edits.csv`,
    )
  }

  return (
    <div className={`list-body annotate nodrag nowheel${compact ? '' : ' annotate--full'}`}>
      <div className="coda-node__tabs" role="tablist" aria-label="Targets">
        {specs.map((spec, i) => {
          const named = specConfig(spec)
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === index}
              className="coda-node__tab annotate__tab"
              title={
                'refused' in named
                  ? named.refused
                  : 'missing' in named
                    ? 'Not set up yet'
                    : undefined
              }
              onClick={() => setActive(i)}
            >
              {specLabel(spec)}
              {!('config' in named) && <span className="annotate__tab-dot" aria-hidden />}
            </button>
          )
        })}
        <button
          type="button"
          className="coda-node__tab"
          title="Add a table or dataset"
          aria-label="Add a table or dataset"
          disabled={locked}
          onClick={() => {
            setSpecs([...specs, newSpec()])
            setActive(specs.length)
          }}
        >
          +
        </button>
      </div>

      <TargetTab
        // A tab's local state — its fold, its ticked rows — is its own.
        key={index}
        spec={specs[index]!}
        onSpec={(next) => setSpecs(specs.map((s, i) => (i === index ? next : s)))}
        onRemove={
          specs.length > 1
            ? () => {
                setSpecs(specs.filter((_, i) => i !== index))
                setActive(Math.max(0, index - 1))
              }
            : undefined
        }
        ids={routing?.routes[index]}
        unserved={routing?.unserved ?? 0}
        session={session}
        locked={locked}
        compact={compact}
        nodeSettings={
          <NodeSettings
            params={cardParams(def, node.params)}
            ctx={ctx}
            node={node}
            setParam={setParam}
          />
        }
        logCount={log.length}
        onExportLog={exportLog}
      />
    </div>
  )
}

/** The card's own settings — which column the ids are in — drawn inside a tab's fold. */
function NodeSettings({
  params,
  ctx,
  node,
  setParam,
}: {
  params: readonly ParamDef[]
  ctx: InferContext
  node: NodeBodyProps['node']
  setParam: NodeBodyProps['setParam']
}) {
  return (
    <>
      {params.map((param) => (
        <label key={param.id} className="list-body__field">
          <span className="param__label" title={param.help ?? param.label}>
            {param.label}
          </span>
          <ParamField
            param={param}
            value={node.params[param.id]}
            ctx={ctx}
            onChange={(v) => setParam(param.id, v)}
          />
        </label>
      ))}
    </>
  )
}

function TargetTab({
  spec,
  onSpec,
  onRemove,
  ids,
  unserved,
  session,
  locked,
  compact,
  nodeSettings,
  logCount,
  onExportLog,
}: {
  spec: TargetSpec
  onSpec: (next: TargetSpec) => void
  onRemove: (() => void) | undefined
  /** The neurons routed to this tab, unqualified. */
  ids: readonly string[] | undefined
  unserved: number
  session: string
  locked: boolean
  compact: boolean
  nodeSettings: ReactNode
  logCount: number
  onExportLog: () => void
}) {
  const named = specConfig(spec)
  const target = 'config' in named ? annotationTarget(named.config) : undefined
  const table = useTargetTable({
    target,
    effects: specEffects(spec),
    ids,
    chosen: spec.fields,
    session,
    locked,
    // Inert where the target offers no blank rows (SeaTable), so no backend test here.
    blanks: spec.unannotated,
  })
  const { fields, columns, rows, records, selected } = table

  const [choosing, setChoosing] = useState(false)
  /*
   * The settings fold away behind the target's name once they name a target: after that they are
   * read far less often than the table, and on a canvas card they were most of it. Open while
   * incomplete or failing, since then they are the only thing worth looking at.
   */
  const [settingsOpen, setSettingsOpen] = useState(() => !target)
  const showSettings = settingsOpen || !target || fields.status === 'error'

  const drawn = useMemo(
    () => (compact ? records.slice(0, CARD_ROWS) : records),
    [records, compact],
  )

  // A CSV tab where the browser cannot write to a file: the backend to switch away from and why,
  // and nothing else — no settings to fill in, no note asking for them.
  const refused = 'refused' in named

  return (
    <>
      {showSettings && (
        <div className="list-body__fields">
          {!refused && nodeSettings}
          <SpecSettings
            spec={spec}
            refused={'refused' in named ? named.refused : undefined}
            onSpec={onSpec}
            disabled={locked}
          />
          {onRemove && (
            <button
              type="button"
              className="annotate__remove"
              disabled={locked}
              onClick={onRemove}
            >
              Remove this tab
            </button>
          )}
        </div>
      )}

      {refused ? null : 'missing' in named ? (
        // `validate`'s sentence, so the card and its badge say the same thing.
        <p className="annotate__note">Set {named.missing.join(', ')}.</p>
      ) : fields.status === 'error' ? (
        <p className="annotate__note annotate__note--error">{fields.message}</p>
      ) : (
        <>
          <div className="annotate__bar">
            <button
              type="button"
              className="annotate__target"
              aria-expanded={showSettings}
              title={showSettings ? 'Hide the settings' : 'Show the settings'}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              {showSettings ? '▾' : '▸'} {target?.label}
            </button>
            <button
              type="button"
              className="annotate__choose"
              aria-expanded={choosing}
              disabled={fields.status !== 'ready'}
              onClick={() => setChoosing((open) => !open)}
            >
              {fields.status === 'ready'
                ? `Fields (${spec.fields.length}) ▾`
                : 'Reading fields…'}
            </button>
            <button
              type="button"
              className="annotate__refresh"
              title="Read the records again"
              onClick={table.refresh}
            >
              ⟳
            </button>
          </div>
          {choosing && fields.status === 'ready' && (
            <FieldChooser
              fields={fields.data}
              chosen={spec.fields}
              onChange={(next) => onSpec({ ...spec, fields: next })}
            />
          )}
          {!locked && (
            <FillBar
              columns={columns.filter((c) => !c.readOnly)}
              count={selected.size}
              onFill={table.fill}
            />
          )}
          <AnnotateTable
            columns={columns}
            records={drawn}
            marks={table.marks}
            edited={table.edited}
            locked={locked}
            selected={selected}
            onSelect={table.onSelect}
            onCommit={table.onCommit}
            onInvalid={table.onInvalid}
          />
        </>
      )}

      <div className="list-body__foot annotate__foot">
        <span>
          {status({
            ids,
            unserved,
            rows,
            fields: columns.length,
            locked,
            hidden: records.length - drawn.length,
          }).map((part, i) => (
            <Fragment key={i}>
              {i > 0 && ' · '}
              {part.loss ? (
                <strong className="annotate__loss" title={part.title}>
                  {part.text}
                </strong>
              ) : (
                part.text
              )}
            </Fragment>
          ))}
        </span>
        {rows.state === 'ask' && (
          <button type="button" onClick={table.confirm}>
            Read {plural(rows.count, 'neuron')}
          </button>
        )}
        <span className="annotate__spacer" />
        <button
          type="button"
          disabled={!table.undoable || locked}
          title={
            table.undoable
              ? "Write this table's last change's previous values back"
              : 'Nothing written to this table to undo'
          }
          onClick={table.undoLast}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={logCount === 0}
          title="Download this card's edits, every tab's, as CSV"
          onClick={onExportLog}
        >
          Log ({logCount})
        </button>
      </div>
    </>
  )
}

/** Ids named in a tooltip before the rest are counted. */
const TITLE_IDS = 20

/** A list of ids for a tooltip, the tail counted rather than listed. */
const idList = (ids: readonly string[]) =>
  ids.slice(0, TITLE_IDS).join(', ') +
  (ids.length > TITLE_IDS ? `, and ${(ids.length - TITLE_IDS).toLocaleString()} more` : '')

interface StatusPart {
  text: string
  /**
   * Neurons the selection holds and this tab will not show — the two ways a selection silently loses
   * part of itself. Drawn bold in the refusal red, so a table missing half its neurons cannot read
   * as a complete one.
   */
  loss?: boolean
  title?: string
}

/** The foot's sentence: how many neurons, what was skipped, and why nothing shows where it does not. */
function status({
  ids,
  unserved,
  rows,
  fields,
  locked,
  hidden,
}: {
  ids: readonly string[] | undefined
  /** Neurons no tab serves. */
  unserved: number
  rows: Rows
  /** How many fields are shown. */
  fields: number
  locked: boolean
  /** Rows read but not drawn on the canvas card. */
  hidden: number
}): StatusPart[] {
  if (!ids) return [{ text: 'No neurons yet — wire a selection and run it.' }]
  const parts: StatusPart[] = [{ text: plural(ids.length, 'neuron') }]
  const say = (text: string) => parts.push({ text })
  if (unserved) {
    parts.push({
      text: `${plural(unserved, 'neuron')} no tab serves`,
      loss: true,
      title: 'Their dataset is not in any tab’s Serves, so no tab shows them.',
    })
  }
  if (fields === 0) say('choose fields to show')
  if (rows.state === 'loading') say('reading…')
  if (rows.state === 'failed') say(rows.message)
  if (rows.state === 'ok' && rows.missing.length) {
    parts.push({
      text: `${rows.missing.length.toLocaleString()} not in this table`,
      loss: true,
      title: `No row for: ${idList(rows.missing)}`,
    })
  }
  if (rows.state === 'ok' && rows.blank) say(`${rows.blank.toLocaleString()} not annotated yet`)
  if (hidden > 0) say(`${plural(hidden, 'more row')} when expanded`)
  if (locked) say('locked — unlock the canvas to edit')
  return parts
}

/** A tab's own settings: where its table is, which datasets it serves, and its side effects. */
function SpecSettings({
  spec,
  refused,
  onSpec,
  disabled,
}: {
  spec: TargetSpec
  /** Why this tab cannot work here (`specConfig`): then the backend and that, nothing else. */
  refused: string | undefined
  onSpec: (next: TargetSpec) => void
  disabled: boolean
}) {
  const text = (key: SpecTextKey, label: string, placeholder: string, help?: string) => (
    <label key={key} className="list-body__field">
      <span className="param__label" title={help ?? label}>
        {label}
      </span>
      <TextField
        label={label}
        value={spec[key]}
        placeholder={placeholder}
        disabled={disabled}
        // On leaving the field, not while typing: a half-typed table name would be a target of its
        // own, its fields looked up and failing.
        debounce={false}
        onChange={(v) => onSpec({ ...spec, [key]: v })}
      />
    </label>
  )
  const check = (key: SpecBoolKey, label: string, caption: string, help: string) => (
    <label key={key} className="list-body__field" title={help}>
      <span className="param__label">{label}</span>
      <span>
        <input
          type="checkbox"
          checked={spec[key]}
          disabled={disabled}
          onChange={(e) => onSpec({ ...spec, [key]: e.target.checked })}
        />{' '}
        {caption}
      </span>
    </label>
  )
  const backend = (
    <label className="list-body__field">
      <span className="param__label">Backend</span>
      <select
        className="field"
        value={spec.backend}
        disabled={disabled}
        onChange={(e) => onSpec({ ...spec, backend: e.target.value as Backend })}
      >
        <option value="seaTable">FlyTable / SeaTable</option>
        <option value="clio">Clio</option>
        <option value="csv">CSV file on this computer</option>
      </select>
    </label>
  )
  if (refused) {
    // Nothing to set: the tab cannot work in this browser, and says so where a setting would be.
    return (
      <>
        {backend}
        <p className="annotate__note annotate__note--error">{refused}</p>
      </>
    )
  }
  return (
    <>
      {backend}
      {spec.backend === 'seaTable' ? (
        <>
          {text('base', 'Base', 'main')}
          {text('table', 'Table', 'info')}
          {text(
            'keyColumn',
            'Key column',
            'root_783',
            'The table’s column holding the neuron id — on FlyWire’s info, the root id of the release your ids are from.',
          )}
          {text(
            'host',
            'Server',
            '',
            'The SeaTable deployment. FlyTable unless you run your own.',
          )}
          {text(
            'workspace',
            'Workspace',
            'from the base',
            'The workspace holding the base. Empty works it out from the base’s name.',
          )}
        </>
      ) : spec.backend === 'csv' ? (
        <>
          <CsvFile
            file={spec.file}
            name={spec.fileName}
            disabled={disabled}
            onChange={(file, fileName) => onSpec({ ...spec, file, fileName })}
          />
          {text(
            'keyColumn',
            'Key column',
            'root_id',
            'The file’s column holding the neuron id, named as in its first row.',
          )}
          {check(
            'unannotated',
            'Missing ids',
            'show as empty rows',
            'A neuron the file has no row for is shown as an empty row; its first edit adds the row to the file. Unticked, such neurons are counted as not in this table.',
          )}
        </>
      ) : (
        <>
          <ClioDataset
            value={spec.dataset}
            disabled={disabled}
            onChange={(dataset) => onSpec({ ...spec, dataset })}
            fallback={text('dataset', 'Dataset', 'CNS', 'The Clio dataset, as Clio names it.')}
          />
          {check(
            'instanceFromType',
            'Instance',
            'keep in step with type',
            'When a type is written, write instance as type_side too — soma side, else root side.',
          )}
          {check(
            'unannotated',
            'Unannotated',
            'show as empty rows',
            'Clio holds nothing for a body nobody has annotated. Ticked, such a body is shown as an empty row you can annotate; unticked, it is counted as not in this dataset. A mistyped id would be editable too.',
          )}
        </>
      )}
      {text(
        'serves',
        'Serves',
        'every neuron',
        'The datasets this tab is for, comma-separated, matched against a qualified id’s prefix or the Dataset column. Empty takes every neuron.',
      )}
    </>
  )
}

/**
 * Clio's datasets as a list to pick from, read with the token in Connections — and re-read when it
 * changes. A peek, so it asks only with a token and quietly: a refusal belongs on this card, not in
 * a Connections dialog opened at somebody choosing a backend. Where there is no list — no token, a
 * refusal, Clio unreachable — the dataset is typed instead (`fallback`), which is how it was before.
 */
function ClioDataset({
  value,
  disabled,
  onChange,
  fallback,
}: {
  value: string
  disabled: boolean
  onChange: (dataset: string) => void
  fallback: ReactNode
}) {
  const listing = useSettledFetch(clioListingKey(), () => clioDatasets())
  if (listing.status !== 'ready') return fallback
  // One the stored graph names and Clio does not list stays on show, marked, rather than vanishing.
  const unlisted = value && !listing.data.includes(value) ? value : undefined
  return (
    <label className="list-body__field">
      <span className="param__label" title="The Clio dataset to read and write">
        Dataset
      </span>
      <select
        className="field"
        aria-label="Dataset"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose a dataset…</option>
        {listing.data.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        {unlisted && <option value={unlisted}>{unlisted} (not listed by Clio)</option>}
      </select>
    </label>
  )
}

/**
 * A CSV tab's file line, by where the file is (`remembered.ts`). Not `localSourceLine`, which Link
 * Table and BigClust share: that draws the permission button inside the line and leaves an absent
 * file's fix to a warning of its own, where this card has one row and names the fix in it.
 */
const FILE_LINE: Record<RememberedState, (name: string) => string> = {
  held: (name) => name,
  restoring: (name) => `Looking for "${name}"…`,
  permission: (name) => `"${name}" — allow Coda to edit it again`,
  absent: (name) => `"${name}" is not open in this browser — choose it again`,
}

/** The CSV types a picker offers. */
const CSV_ACCEPT = ['.csv', '.tsv', '.txt']

/**
 * A CSV tab's file: picked, and — where the browser remembers files — found again after a reload,
 * asked back with a click where writing needs allowing again, and asked for anew where it is gone.
 * Only Chromium's picker hands back a handle that writes (`files/editable.ts`); anywhere else the
 * tab never draws this (`SpecSettings` refuses instead), a table nobody can edit being no use on
 * this card. A pick whose writing was not allowed is refused too: it is not held.
 */
function CsvFile({
  file,
  name,
  disabled,
  onChange,
}: {
  file: string
  name: string
  disabled: boolean
  onChange: (file: string, name: string) => void
}) {
  const [problem, setProblem] = useState<string>()
  // Its own subscription, by value: a tab whose key column is not set yet has no target to ask.
  const state = useSyncExternalStore(subscribeUploadLearned, () =>
    file ? editableFileState(file) : undefined,
  )

  const choose = async () => {
    setProblem(undefined)
    try {
      const [handle] = await window.showOpenFilePicker!({
        types: [{ description: 'CSV', accept: { 'text/csv': CSV_ACCEPT } }],
      })
      if (!handle) return
      // Asked now, inside the click: only a gesture may ask, and editing is the point.
      if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        return setProblem(`Editing "${handle.name}" was not allowed, so it was not opened.`)
      }
      onChange(holdEditableFile(handle), handle.name)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setProblem(errorMessage(error))
      }
    }
  }
  const allow = async () => {
    setProblem(undefined)
    if (!(await grantEditableFile(file))) setProblem(`Editing "${name}" was not allowed.`)
  }

  const line = state ? FILE_LINE[state](name) : 'No file chosen'
  return (
    <label className="list-body__field">
      <span
        className="param__label"
        title="A CSV (or tab-separated) file on this computer. Edits are written straight into it."
      >
        File
      </span>
      <span className="annotate__file">
        <span className={state && state !== 'held' ? 'annotate__note--error' : undefined}>
          {line}
        </span>
        {state === 'permission' ? (
          <button type="button" disabled={disabled} onClick={() => void allow()}>
            Allow editing
          </button>
        ) : (
          <button type="button" disabled={disabled} onClick={() => void choose()}>
            {file ? 'Choose another…' : 'Choose file…'}
          </button>
        )}
        {problem && <span className="annotate__note--error">{problem}</span>}
      </span>
    </label>
  )
}
