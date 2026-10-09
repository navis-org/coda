/** The worker half of `arborDaylight.ts`. The four coordinate arrays move back rather than copy. */

import { serveJob } from '../../data/workerJob'
import { runDaylight } from './arborDaylight'

serveJob(runDaylight, (shape) => [
  shape.x0.buffer,
  shape.y0.buffer,
  shape.x1.buffer,
  shape.y1.buffer,
])
