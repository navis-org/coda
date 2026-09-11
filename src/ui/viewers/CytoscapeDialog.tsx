/**
 * Open in Cytoscape Web: what goes into the file, then a link or a gist.
 *
 * Three toggles rather than a column checklist, deliberately — node attributes, edge attributes,
 * layout. They are also the lever when a graph does not fit in a link: the size readout below them
 * answers each press, so leaving the attributes out is how a graph comes back under the limit.
 *
 * **Nothing is written for a graph no toggle could fit** (`mayFitInLink`). The file for a network
 * of tens of thousands of nodes is megabytes and blocks the main thread to build, and all it would
 * buy here is a size readout for something that is going to a gist regardless — so it is built on
 * Upload, and the readout counts nodes and links instead.
 *
 * **The gist route opens its tab before the upload.** A tab opened after an `await` is outside the
 * click, and browsers block it — `caveSignIn.ts` records the same trap. So the tab is opened blank
 * on the press, pointed at Cytoscape Web once the gist has an address, and closed again if the
 * upload fails.
 */

import { useMemo, useState } from 'react'

import { errorMessage } from '../../core/errors'
import type { NetworkValue } from '../../core/values'
import { getGithubToken } from '../../data/share/credentials'
import { writeScratchGist } from '../../data/share/gist'
import type { CytoscapeChoice } from '../cytoscapeWeb'
import { cytoscapeCx2, dataLink, importLink, mayFitInLink } from '../cytoscapeWeb'
import type { Cx2Options } from '../exportValue'
import { formatBytes, plural } from '../format'
import { UNLISTED_GIST, WhereTheTokenGoes } from '../githubGistNotes'
import { Modal, ModalHeader } from '../Modal'

/** Fixed, so each hand-off replaces the scratch gist's file rather than adding one beside it. */
const SCRATCH_FILE = 'coda-network.cx2'

export interface CytoscapeDialogProps {
  network: NetworkValue
  /** The network's name in Cytoscape Web's workspace list. */
  name: string
  /**
   * The layout on screen, `undefined` where nothing is drawn. Asked **once**, as the dialog opens,
   * so a force layout still settling behind it does not rebuild the file on every tick.
   */
  readPositions: () => Cx2Options['positions']
  onClose: () => void
}

type Sending = { state: 'idle' } | { state: 'working' } | { state: 'error'; message: string }

export function CytoscapeDialog({
  network,
  name,
  readPositions,
  onClose,
}: CytoscapeDialogProps) {
  const [positions] = useState(readPositions)
  const [choice, setChoice] = useState<CytoscapeChoice>({
    nodeAttributes: true,
    edgeAttributes: true,
    layout: positions !== undefined,
  })
  const [sending, setSending] = useState<Sending>({ state: 'idle' })
  const hasToken = Boolean(getGithubToken())

  const mayFit = useMemo(() => mayFitInLink(network), [network])
  const cx2 = useMemo(
    () => (mayFit ? cytoscapeCx2(network, name, choice, positions) : undefined),
    [mayFit, network, name, choice, positions],
  )
  const link = useMemo(() => (cx2 === undefined ? undefined : dataLink(cx2)), [cx2])
  const blocked = !link && !hasToken

  const nodeColumns = network.nodes.schema.columns.length - 1
  const edgeColumns = network.edges.schema.columns.length - 2
  const toggles: Array<{
    key: keyof CytoscapeChoice
    label: string
    disabled: boolean
    note: string
  }> = [
    {
      key: 'nodeAttributes',
      label: 'Node attributes',
      disabled: nodeColumns === 0,
      note: `${plural(nodeColumns, 'column')}. Without them a node keeps its id.`,
    },
    {
      key: 'edgeAttributes',
      label: 'Edge attributes',
      disabled: edgeColumns === 0,
      note: `${plural(edgeColumns, 'column')}.`,
    },
    {
      key: 'layout',
      label: 'Layout',
      disabled: positions === undefined,
      note:
        positions === undefined
          ? 'Nothing is drawn yet, so Cytoscape Web will lay it out.'
          : 'Where the nodes are on screen now. Without it Cytoscape Web lays the graph out itself.',
    },
  ]

  const open = () => {
    if (link) {
      window.open(link, '_blank', 'noopener,noreferrer')
      onClose()
      return
    }
    const tab = window.open('about:blank', '_blank')
    if (!tab) {
      setSending({
        state: 'error',
        message: 'Your browser blocked the new tab. Allow pop-ups for this page and try again.',
      })
      return
    }
    setSending({ state: 'working' })
    writeScratchGist({
      filename: SCRATCH_FILE,
      content: cx2 ?? cytoscapeCx2(network, name, choice, positions),
      description: `${name} — opened in Cytoscape Web from Coda. Rewritten on every hand-off.`,
    }).then(
      (url) => {
        // Severed before navigating, which is what `noopener` would have done at opening.
        tab.opener = null
        tab.location.href = importLink(url)
        onClose()
      },
      (err: unknown) => {
        tab.close()
        setSending({ state: 'error', message: errorMessage(err) })
      },
    )
  }

  return (
    <Modal
      className="overlay__panel share"
      label="Open in Cytoscape Web"
      onClose={onClose}
      portal
    >
      <ModalHeader onClose={onClose}>Open “{name}” in Cytoscape Web</ModalHeader>

      <div className="sources__body share__body">
        <p className="sources__note">
          Cytoscape Web opens a network from a link. A small one travels inside the link itself;
          a larger one goes through a gist on your GitHub account.
        </p>

        <div className="cytoscape-dialog__choices">
          {toggles.map(({ key, label, disabled, note }) => (
            <label className="share__check" key={key}>
              <input
                type="checkbox"
                checked={choice[key]}
                disabled={disabled}
                onChange={() => setChoice((c) => ({ ...c, [key]: !c[key] }))}
              />
              <span>
                {label}
                <em>{note}</em>
              </span>
            </label>
          ))}
        </div>

        <p className="share__size">
          {cx2 === undefined
            ? `${plural(network.nodes.length, 'node')} and ${plural(network.edges.length, 'link')}`
            : formatBytes(cx2.length)}{' '}
          — {link ? 'fits in the link, so nothing is uploaded.' : 'too large for a link.'}
        </p>

        {!link && hasToken ? (
          <p className="sources__note">
            It goes into a secret gist on your GitHub account — one gist, which Coda rewrites on
            every hand-off. <em>{UNLISTED_GIST}</em>
          </p>
        ) : null}

        {blocked ? (
          <p className="share__blocked">
            No GitHub token to put it in a gist. <WhereTheTokenGoes /> Or leave out attributes
            until it fits — and the ⤓ menu’s CX2 file opens from Cytoscape Web’s Data menu at
            any size.
          </p>
        ) : null}

        {sending.state === 'error' ? (
          <p className="sources__result" data-tone="error">
            {sending.message}
          </p>
        ) : null}

        <div className="share__controls">
          <button
            type="button"
            className="btn btn--primary"
            disabled={blocked || sending.state === 'working'}
            onClick={open}
          >
            {sending.state === 'working' ? 'Uploading…' : link ? 'Open ↗' : 'Upload and open ↗'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
