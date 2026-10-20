/**
 * The VFB Info card: Virtual Fly Brain's page for each term in a table, one term at a time.
 *
 * The hover (`ui/vfb/TermHover.tsx`) is the preview of this page: name, definition, one image. The
 * page adds what a connectome user reads next — the types the term is a kind of, its relationships,
 * **the name each connectome gives it** (FBbt's `name_in_*` synonyms, which is how a type found in
 * one dataset is looked up in another), example images, the papers and the cross-references. Terms
 * named in the text are links with the same hover (`ColumnLinkCell` with the name as its label), so
 * a parent type can be read without leaving the page. The term is asked for when its page is shown
 * (`useTermInfo`, shared with the hover).
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'

import { distinctStrings } from '../../core/collections'
import type { TableValue } from '../../core/values'
import { optionalColumn } from '../../core/values'
import type { VfbImage, VfbRef, VfbTermInfo } from '../../data/vfb/client'
import { imagesBrainFirst } from '../../data/vfb/client'
import type { MarkdownSpan } from '../../data/vfb/markdown'
import { vfbTemplate } from '../../data/vfb/templates'
import { plural } from '../../style/format'
import { ColumnLinkCell } from '../ColumnLinkCell'
import { tableToCsvParts } from '../export'
import { LinkedText } from '../LinkedText'
import { Pager } from '../viewers/Pager'
import type { ExportSource } from '../viewers/ViewerActions'
import { ViewerActions } from '../viewers/ViewerActions'
import { ViewerEmpty } from '../viewers/ViewerEmpty'
import { useTermInfo } from './useTermInfo'

export interface VfbInfoViewerProps {
  terms: TableValue | undefined
  /** The resolved `termColumn`. */
  column: string | undefined
  /** The stored `page` param. */
  page: number
  onPage: (next: number) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** Example images shown per page; a class can have hundreds. */
const IMAGES_SHOWN = 8

export function VfbInfoViewer(props: VfbInfoViewerProps) {
  const { terms, column, page, onPage, compact, baseName, onExpand, onError } = props
  // A resolved picker can still name a column the table lacks (its default, before the schema
  // lands), so it is looked for rather than assumed.
  const values = terms && column ? optionalColumn(terms, column) : undefined
  const ids = useMemo(() => (values ? distinctStrings(values) : []), [values])
  const index = Math.min(Math.max(0, page), Math.max(0, ids.length - 1))
  const id = ids[index]
  const loaded = useTermInfo(id)

  if (!terms) return <ViewerEmpty>Connect VFB Neurons, or a table of VFB ids.</ViewerEmpty>
  if (!column) return <ViewerEmpty>Pick the column holding VFB or FBbt term ids.</ViewerEmpty>
  if (!values) return <ViewerEmpty>The incoming table has no {column} column.</ViewerEmpty>
  if (!id) return <ViewerEmpty>No term ids in the {column} column.</ViewerEmpty>

  const info = loaded?.info
  const error = loaded?.error
  const exportSource: ExportSource = { csv: () => tableToCsvParts(terms) }

  return (
    <div className="viewer vfb-info nodrag" data-compact={compact || undefined}>
      <div className="profile__pager">
        <Pager index={index} total={ids.length} onStep={(d) => onPage(index + d)} unit="term" />
        <span className="profile__name" title={info?.label ?? id}>
          {info?.label ?? id}
        </span>
        <span className="profile__spacer" />
        <ColumnLinkCell link="vfb" value={id} />
      </div>
      <div className="vfb-info__body nowheel">
        {error && <p className="vfb-info__muted">{error}</p>}
        {!info && !error && <p className="vfb-info__muted">Asking Virtual Fly Brain…</p>}
        {info && <TermPage info={info} />}
      </div>
      <div className="viewer__caption">
        <span>{plural(ids.length, 'term')}</span>
        <ViewerActions
          baseName={baseName ?? 'vfb-info'}
          source={exportSource}
          compact={compact}
          {...(onExpand ? { onExpand } : {})}
          {...(onError ? { onError } : {})}
        />
      </div>
    </div>
  )
}

function TermPage({ info }: { info: VfbTermInfo }) {
  const datasetNames = info.synonyms.filter((s) => s.dataset)
  // `synonyms` is already one entry per name and dataset, so these are distinct.
  const otherNames = info.synonyms
    .filter((s) => !s.dataset && s.label !== info.name && s.label !== info.label)
    .map((s) => s.label)
  return (
    <>
      <div className="vfb-info__title">
        {info.name !== info.label && <span className="vfb-info__symbol">{info.name}</span>}
        {info.tags.map((tag) => (
          <span key={tag} className="vfb-info__tag">
            {tag.replace(/_/g, ' ')}
          </span>
        ))}
      </div>
      <Section title="Definition" shown={info.definition.length > 0}>
        <p>
          <Spans spans={info.definition} />
        </p>
      </Section>
      <Section title="Comment" shown={info.comment.length > 0}>
        <p>
          <Spans spans={info.comment} />
        </p>
      </Section>
      <Section
        title={info.isClass ? 'A kind of' : 'An instance of'}
        shown={info.parents.length > 0}
      >
        <Refs refs={info.parents} />
      </Section>
      <Section title="Relationships" shown={info.relations.length > 0}>
        <dl className="vfb-info__pairs">
          {info.relations.map((r) => (
            <div key={r.relation}>
              <dt>{r.relation.replace(/_/g, ' ')}</dt>
              <dd>
                <Refs refs={r.targets} />
              </dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Names in connectomes" shown={datasetNames.length > 0}>
        <dl className="vfb-info__pairs">
          {datasetNames.map((s) => (
            <div key={`${s.dataset}\u0000${s.label}`}>
              <dt>{s.dataset}</dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Also known as" shown={otherNames.length > 0}>
        <p>{otherNames.join(', ')}</p>
      </Section>
      <Images info={info} />
      <Section title={plural(info.papers.length, 'paper')} shown={info.papers.length > 0}>
        <ul className="vfb-info__list">
          {info.papers.map((paper) => (
            <li key={paper.id ?? paper.title}>
              {paper.id ? <TermName id={paper.id} label={paper.title} /> : paper.title}
              {paper.doi && (
                <span className="vfb-info__muted">
                  {' · DOI '}
                  <ColumnLinkCell link="doi" value={paper.doi} />
                </span>
              )}
              {paper.pmid && (
                <span className="vfb-info__muted">
                  {' · PubMed '}
                  <ColumnLinkCell link="pmid" value={paper.pmid} />
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Elsewhere" shown={info.xrefs.length > 0}>
        <ul className="vfb-info__list">
          {info.xrefs.map((x) => (
            <li key={x.url}>
              {x.label}: <LinkedText text={x.url} />
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}

/** A class's example images, or an individual's own, brain template first and a few at most. */
function Images({ info }: { info: VfbTermInfo }) {
  const all = imagesBrainFirst(info.images).filter((image) => image.thumbnail)
  const shown = all.slice(0, IMAGES_SHOWN)
  const title = info.isClass ? 'Example images' : 'Images'
  return (
    <Section title={title} shown={shown.length > 0}>
      <div className="vfb-info__images">
        {shown.map((image) => (
          <Thumbnail key={`${image.template}\u0000${image.id}`} image={image} />
        ))}
      </div>
      {all.length > shown.length && (
        <p className="vfb-info__muted">
          {plural(all.length - shown.length, 'more image')} on VFB’s page.
        </p>
      )}
    </Section>
  )
}

function Thumbnail({ image }: { image: VfbImage }) {
  return (
    <figure className="vfb-info__image">
      <div className="vfb-info__frame">
        <img src={image.thumbnail} alt={image.label} loading="lazy" draggable={false} />
      </div>
      <figcaption>
        <TermName id={image.id} label={image.label} />
        <span className="vfb-info__muted">
          {vfbTemplate(image.template)?.label ?? image.template}
        </span>
      </figcaption>
    </figure>
  )
}

function Section({
  title,
  shown,
  children,
}: {
  title: string
  shown: boolean
  children: ReactNode
}) {
  if (!shown) return null
  return (
    <section className="vfb-info__section">
      <h4 className="vfb-info__heading">{title}</h4>
      {children}
    </section>
  )
}

/** A term named in VFB's text: its name, linked to its VFB page, with the term hover. */
const TermName = ({ id, label }: VfbRef) => (
  <ColumnLinkCell link="vfb" value={id} label={label} />
)

/** VFB's text with its term links drawn as links. */
function Spans({ spans }: { spans: readonly MarkdownSpan[] }) {
  return (
    <>
      {spans.map((span, i) =>
        span.target ? <TermName key={i} id={span.target} label={span.text} /> : span.text,
      )}
    </>
  )
}

/** Terms separated by commas. */
function Refs({ refs }: { refs: readonly VfbRef[] }) {
  return (
    <>
      {refs.map((ref, i) => (
        <span key={ref.id}>
          {i > 0 && ', '}
          <TermName {...ref} />
        </span>
      ))}
    </>
  )
}
