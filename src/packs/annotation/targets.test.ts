import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { newSpec, readSpecs, specConfig, specEffects, specLabel, writeSpecs } from './targets'

describe('an Annotate card’s targets', () => {
  it('always has one, and reads stored ones tolerantly', () => {
    expect(readSpecs([])).toEqual([newSpec()])
    const stored = writeSpecs([{ ...newSpec(), base: 'main' }])
    expect(readSpecs([...stored, 'not json', '42', '[]'])).toEqual([
      { ...newSpec(), base: 'main' },
    ])
  })

  it('gives a field of the wrong type its default, so a hand-edited file cannot crash the card', () => {
    const [spec] = readSpecs([
      JSON.stringify({
        backend: 'cave',
        fields: null,
        base: 7,
        table: 'info',
        unannotated: 'yes',
        instanceFromType: true,
      }),
    ])
    expect(spec).toEqual({ ...newSpec(), table: 'info', instanceFromType: true })
    expect(readSpecs([JSON.stringify({ fields: ['type', 3] })])[0]!.fields).toEqual(['type'])
  })

  it('drops what a tab saved before presets were taken out', () => {
    const [spec] = readSpecs([
      JSON.stringify({ base: 'main', table: 'info', preset: 'flywire', initials: 'PS' }),
    ])
    expect(spec).toEqual({ ...newSpec(), base: 'main', table: 'info' })
  })

  it('writes instance from type only on Clio, and only once switched on', () => {
    expect(specEffects(newSpec())).toEqual({})
    expect(specEffects({ ...newSpec(), instanceFromType: true })).toEqual({})
    expect(specEffects({ ...newSpec(), backend: 'clio' })).toEqual({})
    expect(specEffects({ ...newSpec(), backend: 'clio', instanceFromType: true })).toEqual({
      instanceFromType: true,
    })
  })

  it('names a tab by its table or its dataset', () => {
    expect(specLabel(newSpec())).toBe('New table')
    expect(specLabel({ ...newSpec(), base: 'main', table: 'info' })).toBe('main / info')
    expect(specLabel({ ...newSpec(), backend: 'clio', dataset: 'CNS' })).toBe('Clio · CNS')
    expect(specLabel({ ...newSpec(), backend: 'csv', fileName: 'types.csv' })).toBe(
      'CSV · types.csv',
    )
  })

  it('refuses a CSV tab, asking for nothing, in a browser that cannot write to a file', () => {
    // Node has no File System Access picker, as Firefox and Safari have none.
    expect(specConfig({ ...newSpec(), backend: 'csv' })).toEqual({
      refused: expect.stringMatching(/^A CSV tab cannot work here: .*Chromium/),
    })
  })

  it('says which settings a target still needs, in the words the card uses', () => {
    expect(specConfig(newSpec())).toEqual({ missing: ['Base', 'Table', 'Key column'] })
    expect(specConfig({ ...newSpec(), backend: 'clio' })).toEqual({ missing: ['Dataset'] })
    // A Chromium browser: one with the File System Access picker.
    vi.stubGlobal('window', { showOpenFilePicker: () => undefined })
    onTestFinished(() => void vi.unstubAllGlobals())
    expect(specConfig({ ...newSpec(), backend: 'csv' })).toEqual({
      missing: ['File', 'Key column'],
    })
    expect(
      specConfig({
        ...newSpec(),
        backend: 'csv',
        file: 'edit-1',
        fileName: 'types.csv',
        keyColumn: ' root_id ',
      }),
    ).toEqual({
      config: { backend: 'csv', file: 'edit-1', name: 'types.csv', keyColumn: 'root_id' },
    })
    expect(
      specConfig({ ...newSpec(), base: 'main', table: 'info', keyColumn: 'root_783' }),
    ).toMatchObject({
      config: { backend: 'seaTable', base: 'main', table: 'info', idColumn: 'root_783' },
    })
  })
})
