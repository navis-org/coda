import { it } from 'vitest'
import './nodes'
import { listableNodeDefs } from './core/registry'
import { nodeBody } from './ui/nodes/nodeBodies'

it('probe', () => {
  const rows: string[] = []
  for (const d of listableNodeDefs()) {
    const ps = d.params ?? []
    const adv = ps.filter((p) => p.advanced)
    const vis = ps.filter((p) => !p.advanced)
    const cond = ps.filter((p) => p.visibleIf)
    if (adv.length || cond.length)
      rows.push(
        `${d.type.padEnd(26)} cat=${d.category.padEnd(14)} body=${nodeBody(d.type) ? 'Y' : 'n'} total=${String(ps.length).padStart(2)} card=${String(vis.length).padStart(2)} adv=${String(adv.length).padStart(2)} cond=${cond.length}`,
      )
  }
  console.log(rows.join('\n'))
  console.log('nodes with advanced params:', rows.length, 'of', listableNodeDefs().length)
})
