/** The worker half of Simulate (`simulateJob.ts`). Every result buffer moves back rather than copies. */

import { serveJob } from '../../data/workerJob'
import { runSimulateJob } from './simulateJob'

serveJob(runSimulateJob)
