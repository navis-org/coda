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
 */

import { useMemo } from 'react'

import type { MarkdownBlock, MarkdownInline, MarkdownList } from './markdown'
import { parseMarkdown } from './markdown'

export function MarkdownView({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  )
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h5'
      return (
        <Tag className="markdown__heading">
          <Inlines nodes={block.children} />
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p className="markdown__p">
          <Inlines nodes={block.children} />
        </p>
      )
    case 'list':
      return <List list={block} />
  }
}

function List({ list }: { list: MarkdownList }) {
  const Tag = list.ordered ? 'ol' : 'ul'
  return (
    <Tag className="markdown__list">
      {list.items.map((item, i) => (
        <li key={i} className="markdown__item">
          <Inlines nodes={item.children} />
          {item.list && <List list={item.list} />}
        </li>
      ))}
    </Tag>
  )
}

function Inlines({ nodes }: { nodes: MarkdownInline[] }) {
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
                <Inlines nodes={node.children} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={node.children} />
              </em>
            )
          case 'link':
            return (
              <a
                key={i}
                className="markdown__link"
                href={node.href}
                target="_blank"
                rel="noopener noreferrer"
                title={node.href}
              >
                <Inlines nodes={node.children} />
              </a>
            )
        }
      })}
    </>
  )
}
