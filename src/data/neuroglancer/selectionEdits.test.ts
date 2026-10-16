/**
 * The edits a Neuroglancer card keeps on top of its input — what somebody double-clicked into or
 * out of the scene. The failures worth pinning are the quiet ones: an upstream change read as the
 * user removing neurons, a toggle that leaves a trace, a stored id that would kill the viewer.
 */

import { describe, expect, it } from 'vitest'

import type { NgScene } from './scene'
import { layerListing } from './scene'
import {
  NO_EDITS,
  applySelectionEdits,
  decodeSelectionEdits,
  encodeSelectionEdits,
  mergeShownSegments,
} from './selectionEdits'

const edits = (added: string[], removed: string[] = [], hidden: string[] = []) => ({
  added: new Set(added),
  removed: new Set(removed),
  hidden: new Set(hidden),
})

describe('the stored form', () => {
  it('round-trips, sorted numerically so the same edits are the same text', () => {
    const stored = encodeSelectionEdits(edits(['30', '4'], ['200', '100'], ['7']))
    expect(stored).toEqual(['+4', '+30', '-100', '-200', '~7'])
    expect(decodeSelectionEdits(stored)).toEqual(edits(['4', '30'], ['100', '200'], ['7']))
  })

  it('drops what neuroglancer could not parse, and unknown prefixes', () => {
    // One unparseable segment id costs the viewer, not one neuron — see `isSegmentId`.
    const read = decodeSelectionEdits(['+12', '+LC4', '-007', '*5', '-1e21', 7, '+'])
    expect(read).toEqual(edits(['12']))
  })

  it('reads anything that is not a list as no edits', () => {
    expect(decodeSelectionEdits(undefined)).toBe(NO_EDITS)
    expect(decodeSelectionEdits('+12')).toBe(NO_EDITS)
  })
})

describe('applying edits to the input', () => {
  it('keeps the input order, drops the removed, and appends the added', () => {
    expect(applySelectionEdits(['5', '3', '9'], edits(['20', '1'], ['3']))).toEqual([
      '5',
      '9',
      '1',
      '20',
    ])
  })

  it('does not repeat an added id the input already holds', () => {
    expect(applySelectionEdits(['5', '3'], edits(['3']))).toEqual(['5', '3'])
  })
})

describe('folding what the viewer shows into the edits', () => {
  it('adds a neuron double-clicked in and removes one double-clicked out', () => {
    const next = mergeShownSegments(NO_EDITS, ['1', '2'], ['1', '7'])
    expect(next).toEqual(edits(['7'], ['2']))
  })

  it('leaves no trace of a neuron toggled twice', () => {
    const added = mergeShownSegments(NO_EDITS, ['1'], ['1', '7'])
    // The node has rebuilt the scene with 7 in it, and it is double-clicked out again.
    expect(mergeShownSegments(added, ['1', '7'], ['1'])).toEqual(NO_EDITS)
    const removed = mergeShownSegments(NO_EDITS, ['1', '2'], ['1'])
    expect(mergeShownSegments(removed, ['1'], ['1', '2'])).toEqual(NO_EDITS)
  })

  it('measures against what was sent, so an upstream change is not read as the user’s', () => {
    // The input grew from [1] to [1, 2, 3] upstream, but the frame was sent [1] and still shows
    // it. Diffed against the new input, 2 and 3 would read as removed by somebody.
    expect(mergeShownSegments(NO_EDITS, ['1'], ['1'])).toEqual(NO_EDITS)
  })

  it('replaces the hidden set where hidden neurons stay selected, and keeps it otherwise', () => {
    const kept = mergeShownSegments(edits([], [], ['3']), ['1', '2'], ['1', '2'], ['2'])
    expect(kept).toEqual(edits([], [], ['2']))
    expect(mergeShownSegments(kept, ['1', '2'], ['1', '2']).hidden).toEqual(new Set(['2']))
  })

  it('is idempotent across repeated reports of the same scene', () => {
    const once = mergeShownSegments(NO_EDITS, ['1'], ['1', '7'])
    expect(mergeShownSegments(once, ['1'], ['1', '7'])).toEqual(once)
  })
})

describe('reading a scene', () => {
  const scene: NgScene = {
    layers: [
      { type: 'image', name: 'em' },
      { type: 'segmentation', name: 'banc', segments: ['10', '!11', 12, 'LC4'] },
    ],
  }

  it('reads the layer’s shown segments, skipping hidden (`!`) and unparseable ones', () => {
    expect(layerListing(scene, 'banc')?.shown).toEqual(['10', '12'])
  })

  it('says when the layer is not there at all, which is not the same as empty', () => {
    expect(layerListing(scene, 'gone')).toBeUndefined()
    expect(layerListing({ layers: [{ name: 'banc' }] }, 'banc')?.shown).toEqual([])
  })
})
