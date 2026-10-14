/**
 * An identifier of a link kind (`ColumnSchema.link`), drawn: a link labelled with the identifier,
 * and — for a kind that has one — a hover saying what it is.
 *
 * The per-kind table of *drawing*, beside `columnLinks.ts`' table of URLs, so a viewer showing
 * identifier cells names no kind: the table viewer and the VFB gallery's large view both draw
 * through here. A `Record`, so a new kind in `ColumnLink` is a compile-time decision about its
 * hover as well as its URL. A term named in VFB's text (the VFB Info card) draws through here too.
 */

import type { ComponentType, ReactNode } from 'react'

import type { ColumnLink } from '../core/types'
import { columnHref } from './columnLinks'
import { IdLink } from './LinkedText'
import { TermHover } from './vfb/TermHover'

const HOVERS: Record<
  ColumnLink,
  ComponentType<{ id: string; children: ReactNode }> | undefined
> = {
  doi: undefined,
  pmid: undefined,
  vfb: TermHover,
}

/**
 * The identifier as a link, or as plain text when the value is not one this kind can link.
 * `label` replaces the identifier as the text — a term's name where VFB's prose names it — which
 * `IdLink` says why it may.
 */
export function ColumnLinkCell({
  link,
  value,
  label = value,
}: {
  link: ColumnLink
  value: string
  label?: string
}) {
  const href = columnHref(link, value)
  if (!href) return <>{label}</>
  const Hover = HOVERS[link]
  const anchor = <IdLink text={label} href={href} />
  return Hover ? <Hover id={value}>{anchor}</Hover> : anchor
}
