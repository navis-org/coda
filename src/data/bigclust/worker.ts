/**
 * BigClust's wide files made long, off the main thread: the k-NN graph and the feature vectors are
 * the two reads that decode tens of millions of cells (`long.ts`).
 */

import { serveJob } from '../workerJob'
import { longJob, longTransfer } from './long'

serveJob(longJob, longTransfer)
