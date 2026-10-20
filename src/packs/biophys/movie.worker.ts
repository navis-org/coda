/** The worker half of Playback's movie (`runMovieJob`). Its one buffer moves back rather than copies. */

import { serveJob } from '../../data/workerJob'
import { runMovieJob } from './simulateJob'

serveJob(runMovieJob)
