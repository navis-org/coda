// @vitest-environment jsdom
/**
 * Simulate's full-size view, rendered: Partners first while there is nothing to play, and Playback
 * saying why it has nothing to show rather than starting a movie of a run that never happened.
 * The movie itself is `simulate.test.ts`' (`runMovieJob`) and its colours `movie.test.ts`'.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { installJsdomStubs } from '../../test/jsdomStubs'
import { SimulateView } from './SimulateView'

beforeAll(() => installJsdomStubs())
afterEach(cleanup)

describe('SimulateView', () => {
  it('opens on Partners before a run, and Playback asks for one', () => {
    render(
      <SimulateView
        nodeId="sim"
        model={undefined}
        params={{ silenced: [] }}
        record={undefined}
        spikes={undefined}
        current={undefined}
        column={() => undefined}
        viewerKey="sim"
      />,
    )
    expect(screen.getByRole('tab', { name: 'Partners' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByText(/Wire a Compartment Model/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Playback' }))
    expect(screen.getByText('Run the simulation to play it back.')).toBeTruthy()
  })
})
