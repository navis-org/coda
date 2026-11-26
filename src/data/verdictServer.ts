/**
 * The lab's verdict log (`transform_service`'s `/verdicts`), where `verdictLog.ts` sends a reader's
 * verdicts. Its own module so the test guard (`src/test/writeGuard.ts`) can refuse it without
 * loading the log, and with it the CAVE client, into every test file.
 */
export const VERDICT_SERVER = 'https://flyem.mrc-lmb.cam.ac.uk/transform-service/verdicts'
