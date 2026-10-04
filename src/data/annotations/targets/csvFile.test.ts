/**
 * The CSV target against a file in memory, through a stand-in for Chromium's file handle — what it
 * reads, what a write leaves of the file, and the checks every target makes.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { holdEditableFile, resetEditableFiles } from '../../files/editable'
import { CsvTarget, parseCsv, writeCsv } from './csvFile'

/** A file handle whose contents are `disk.text`, and which counts its writes. */
function handle(text: string, permission: PermissionState = 'granted') {
  const disk = { text, writes: 0 }
  const fake = {
    kind: 'file',
    name: 'types.csv',
    getFile: async () => new File([disk.text], 'types.csv'),
    queryPermission: async () => permission,
    requestPermission: async () => permission,
    createWritable: async () => {
      let next = ''
      return {
        write: async (chunk: string) => void (next += chunk),
        close: async () => {
          disk.text = next
          disk.writes++
        },
      }
    },
  }
  return { disk, fake: fake as unknown as FileSystemFileHandle }
}

function target(text: string, keyColumn = 'root_id', permission?: PermissionState) {
  const { disk, fake } = handle(text, permission)
  const file = holdEditableFile(fake)
  return { disk, csv: new CsvTarget({ file, name: 'types.csv', keyColumn }) }
}

const BIG = '720575940621522189'

afterEach(resetEditableFiles)

describe('a CSV file as an annotation target', () => {
  it('reads each id’s rows as text, an 18-digit id exactly, and counts the ids it lacks', async () => {
    const { csv } = target(`root_id,type,side\n${BIG},LC4,R\n10035,,L\n10035,LC6,\n`)
    expect(await csv.fields()).toEqual([
      { name: 'root_id', kind: 'text', readOnly: 'the id column' },
      { name: 'type', kind: 'text' },
      { name: 'side', kind: 'text' },
    ])
    const read = await csv.read([BIG, '10035', '99'], ['type', 'side'])
    expect(read.records).toEqual([
      { key: `${BIG}#1`, id: BIG, values: { type: 'LC4', side: 'R' } },
      // Empty is null; one id's rows are numbered in file order, so a sort cannot swap them.
      { key: '10035#1', id: '10035', values: { type: null, side: 'L' } },
      { key: '10035#2', id: '10035', values: { type: 'LC6', side: null } },
    ])
    expect(read.missing).toEqual(['99'])
  })

  it('writes a cell back and leaves the rest of the file as it was', async () => {
    const { csv, disk } = target('root_id\ttype\tnote\r\n1\tLC4\ta, b\r\n2\tLC6\t\r\n')
    const result = await csv.write([
      { key: '2#1', field: 'type', value: 'LC6a', before: 'LC6' },
    ])
    expect(result.written).toHaveLength(1)
    // The tab delimiter, the CRLF and the trailing newline kept; nothing needed quoting.
    expect(disk.text).toBe('root_id\ttype\tnote\r\n1\tLC4\ta, b\r\n2\tLC6a\t\r\n')
  })

  it('quotes only a cell that needs it', () => {
    const parsed = parseCsv('id,note\n1,plain\n')
    parsed.rows[0]![1] = 'says "hi", twice'
    expect(writeCsv(parsed)).toBe('id,note\n1,"says ""hi"", twice"\n')
  })

  it('holds a write to a cell changed in the file since it was read', async () => {
    const { csv, disk } = target('root_id,type\n1,LC4\n')
    disk.text = 'root_id,type\n1,LC4b\n'
    const result = await csv.write([
      { key: '1#1', field: 'type', value: 'LC4a', before: 'LC4' },
    ])
    expect(result.conflicts).toEqual([
      { change: { key: '1#1', field: 'type', value: 'LC4a', before: 'LC4' }, now: 'LC4b' },
    ])
    expect(disk.writes).toBe(0)
  })

  it('offers an empty row for an id the file lacks, and appends it on its first edit', async () => {
    const { csv, disk } = target('root_id,type,side\n1,LC4,R\n')
    expect(csv.blank('7', ['type'])).toEqual({ key: '7#1', id: '7', values: { type: null } })
    await csv.write([{ key: '7#1', field: 'type', value: 'T4', before: null }])
    expect(disk.text).toBe('root_id,type,side\n1,LC4,R\n7,T4,\n')
  })

  it('queues writes, so two at once both land', async () => {
    const { csv, disk } = target('root_id,type\n1,a\n2,b\n')
    await Promise.all([
      csv.write([{ key: '1#1', field: 'type', value: 'x', before: 'a' }]),
      csv.write([{ key: '2#1', field: 'type', value: 'y', before: 'b' }]),
    ])
    expect(disk.text).toBe('root_id,type\n1,x\n2,y\n')
  })

  it('queues writes per file, so two tabs on one file with different key columns both land', async () => {
    const { disk, fake } = handle('root_id,alt,type\n1,x,a\n2,y,b\n')
    const file = holdEditableFile(fake)
    const byRoot = new CsvTarget({ file, name: 'types.csv', keyColumn: 'root_id' })
    const byAlt = new CsvTarget({ file, name: 'types.csv', keyColumn: 'alt' })
    await Promise.all([
      byRoot.write([{ key: '1#1', field: 'type', value: 'A', before: 'a' }]),
      byAlt.write([{ key: 'y#1', field: 'type', value: 'B', before: 'b' }]),
    ])
    expect(disk.text).toBe('root_id,alt,type\n1,x,A\n2,y,B\n')
  })

  it('says which column is missing, and refuses to write without permission', async () => {
    await expect(target('id,type\n1,a\n').csv.read(['1'], ['type'])).rejects.toThrow(
      /no column "root_id". It has: id, type/,
    )
    const { csv } = target('root_id,type\n1,a\n', 'root_id', 'prompt')
    // Said on the columns before anybody types, and again if a write is tried anyway.
    expect((await csv.fields())[1]!.readOnly).toMatch(/not allowed/)
    const result = await csv.write([{ key: '1#1', field: 'type', value: 'b', before: 'a' }])
    expect(result.failed[0]!.message).toMatch(/writing to it was not allowed/)
  })

  it('refuses in a browser that cannot write to a file, rather than offering a table nobody can edit', async () => {
    // No File System Access picker here (Node), as in Firefox or Safari.
    const csv = new CsvTarget({
      file: 'edit-elsewhere',
      name: 'types.csv',
      keyColumn: 'root_id',
    })
    await expect(csv.fields()).rejects.toThrow(
      /cannot be opened here: .*needs a Chromium browser/,
    )
  })
})
