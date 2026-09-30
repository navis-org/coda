/**
 * The table-file reader, off the main thread.
 *
 * A lookup in a multi-gigabyte file is seconds to minutes of decoding, and on the page thread that
 * is a frozen canvas and a Cancel button nobody can press. So the whole read happens here and only
 * the kept rows come back. The body is `readRowsJob`, which the no-worker fallback runs too.
 */

import { serveJob } from '../workerJob'
import { readRowsJob } from './read'

serveJob(readRowsJob)
