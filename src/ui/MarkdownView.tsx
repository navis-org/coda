/**
 * Render the markdown subset `markdown.ts` parses.
 *
 * Every node becomes a React element, so a dataset blurb can never introduce markup: raw HTML in
 * the source arrived as a `text` node and is escaped by React on the way out. That is the whole
 * reason for parsing to an AST rather than to an HTML string — see the note in `markdown.ts`.
 *
 * Links open in a new tab. This app is a canvas holding unsaved work, and navigating away from a
 * citation link would take the graph with it; `noopener` because the opened page has no business
 * reaching back through `window.opener`.
 *
 * ## Two entry points, and why the second exists
 *
 * `MarkdownView` takes text and parses it. `MarkdownBlocks` takes an already-parsed document,
 * which is what `src/help` has — its documents are parsed once when they load and kept, so
 * handing this component the source again would parse an eight-page document on every render of
 * the overlay it sits in.
 *
 * The extended block kinds are rendered here rather than in a second component, so there stays
 * exactly one place that turns markdown into elements. What is *not* here is any interpretation
 * of a fence's contents: `options.renderFence` is how a caller draws one, and a caller that
 * passes nothing gets a `<pre>`. That keeps the figure machinery — which needs the node registry
 * — out of the component that renders a blurb from a stranger's server.
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'

import type {
  MarkdownBlock,
  MarkdownFence,
  MarkdownInline,
  MarkdownList,
  MarkdownTable,
} from './markdown'
import { parseInline, parseMarkdown } from './markdown'

export interface MarkdownRenderOptions {
  /** Draw a fenced block. Without this a fence renders as preformatted text. */
  renderFence?: (fence: MarkdownFence) => ReactNode
  /**
   * Turn an image's `src` into a URL, or `undefined` if there is no such image.
   *
   * Required for an image to render at all: a document does not sit at a URL, so a `src` that
   * has not been resolved by somebody who knows where the file went is not something this
   * component may put in an `<img>`. An unresolved image draws its alt text, which is the
   * failure that still says what was meant to be there.
   */
  resolveImage?: (src: string) => string | undefined
  /**
   * Handle a `#target` link — the in-document navigation `src/help` uses to cross-reference one
   * node's document from another's. Without it a fragment link renders as plain text rather than
   * as an anchor to a page that has no such anchor.
   */
  onNavigate?: (target: string) => void
}

export function MarkdownView({
  source,
  className,
  options,
  extended,
}: {
  source: string
  className?: string
  options?: MarkdownRenderOptions
  /** Parse the extended block kinds. Off by default — see `ParseOptions` in `markdown.ts`. */
  extended?: boolean
}) {
  const blocks = useMemo(
    () => parseMarkdown(source, { extended: extended === true }),
    [source, extended],
  )
  return <MarkdownBlocks blocks={blocks} className={className} options={options} />
}

export function MarkdownBlocks({
  blocks,
  className,
  options,
}: {
  blocks: readonly MarkdownBlock[]
  className?: string
  options?: MarkdownRenderOptions
}) {
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} options={options} />
      ))}
    </div>
  )
}

function Block({ block, options }: { block: MarkdownBlock; options?: MarkdownRenderOptions }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h5'
      return (
        <Tag className="markdown__heading" data-level={block.level}>
          <Inlines nodes={block.children} options={options} />
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p className="markdown__p">
          <Inlines nodes={block.children} options={options} />
        </p>
      )
    case 'list':
      return <List list={block} options={options} />
    case 'fence': {
      const drawn = options?.renderFence?.(block)
      if (drawn !== undefined && drawn !== null) return <>{drawn}</>
      return (
        <pre className="markdown__pre" data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      )
    }
    case 'callout':
      return (
        <aside className="markdown__callout" data-tone={block.tone}>
          {/*
           * The title goes through the inline parser rather than being printed as text: a
           * warning is very often *about* a named setting, and `` `Normalise` `` in one rendered
           * as three literal characters plus backticks. Parsed here rather than in
           * `markdown.ts`, which keeps `title` a plain string for the tone default and for the
           * tests that read it.
           */}
          <div className="markdown__callout-title">
            <Inlines nodes={parseInline(block.title ?? '')} options={options} />
          </div>
          <MarkdownBlocks
            blocks={block.blocks}
            className="markdown__callout-body"
            options={options}
          />
        </aside>
      )
    case 'table':
      return <Table table={block} options={options} />
    case 'image': {
      const url = options?.resolveImage?.(block.src)
      /*
       * The caption is the alt text rather than a second string, so a figure cannot end up
       * captioned and unreadable to a screen reader at the same time. `<figure>` because a
       * bare `<img>` with a `<div>` under it says nothing about the two belonging together.
       */
      if (!url) return <p className="markdown__p markdown__missing">{block.alt}</p>
      return (
        <figure className="markdown__figure">
          <img src={url} alt={block.alt} loading="lazy" />
          {block.alt && <figcaption>{block.alt}</figcaption>}
        </figure>
      )
    }
  }
}

function Table({ table, options }: { table: MarkdownTable; options?: MarkdownRenderOptions }) {
  return (
    /* Its own scroll container: a wide table must not be what makes the page scroll sideways. */
    <div className="markdown__table-scroll">
      <table className="markdown__table">
        <thead>
          <tr>
            {table.head.map((cell, i) => (
              <th key={i} style={{ textAlign: table.align[i] ?? 'left' }}>
                <Inlines nodes={cell} options={options} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} style={{ textAlign: table.align[j] ?? 'left' }}>
                  <Inlines nodes={cell} options={options} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function List({ list, options }: { list: MarkdownList; options?: MarkdownRenderOptions }) {
  const Tag = list.ordered ? 'ol' : 'ul'
  return (
    <Tag className="markdown__list">
      {list.items.map((item, i) => (
        <li key={i} className="markdown__item">
          <Inlines nodes={item.children} options={options} />
          {item.list && <List list={item.list} options={options} />}
        </li>
      ))}
    </Tag>
  )
}

function Inlines({
  nodes,
  options,
}: {
  nodes: MarkdownInline[]
  options?: MarkdownRenderOptions
}) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.kind) {
          case 'text':
            return <span key={i}>{node.text}</span>
          case 'code':
            return (
              <code key={i} className="markdown__code">
                {node.text}
              </code>
            )
          case 'strong':
            return (
              <strong key={i}>
                <Inlines nodes={node.children} options={options} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={node.children} options={options} />
              </em>
            )
          case 'link': {
            /*
             * A fragment is an in-document jump, and this app is one page — so it is handled by
             * the caller or it is not a link at all. A `<button>` rather than an `<a href="#x">`:
             * there is no such anchor on the page, and an anchor that resolves to nothing moves
             * the scroll position to the top when clicked.
             */
            if (node.href.startsWith('#')) {
              const target = node.href.slice(1)
              const navigate = options?.onNavigate
              if (!navigate) {
                return (
                  <span key={i}>
                    <Inlines nodes={node.children} options={options} />
                  </span>
                )
              }
              return (
                <button
                  key={i}
                  type="button"
                  className="markdown__link markdown__link--internal"
                  onClick={() => navigate(target)}
                >
                  <Inlines nodes={node.children} options={options} />
                </button>
              )
            }
            return (
              <a
                key={i}
                className="markdown__link"
                href={node.href}
                target="_blank"
                rel="noopener noreferrer"
                title={node.href}
              >
                <Inlines nodes={node.children} options={options} />
              </a>
            )
          }
        }
      })}
    </>
  )
}
