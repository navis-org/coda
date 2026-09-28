/**
 * The half of `record-tutorial.mjs` that runs after the browser has closed: mix the audio, encode
 * the video, write the captions and chapters.
 *
 * A module of its own so that `pnpm tutorial <name> --remix` can run it again over a take already
 * on disk. Everything it reads is in `tutorials/out/<name>/` — the frames and `frames.txt`, one
 * narration clip per step in `audio/`, and `timings.json` — so a change of music or music level
 * costs a few seconds of ffmpeg rather than a minute of re-recording.
 *
 * ## The music
 *
 * A bed under the voice, **ducked**: `sidechaincompress` keyed on the narration pulls the music
 * down while somebody is speaking and lets it back up in the gaps. Two things about it are not
 * obvious:
 *
 * - The bed's level is set in **loudness units, not gain**. Tracks are mastered anywhere from
 *   -8 to -20 LUFS, so "-20 dB" means a different mix for every file; normalising the track to a
 *   target first (`MUSIC_LUFS`) makes the one knob mean the same thing whatever file is named.
 * - The whole mix is then normalised to `MIX_LUFS`, YouTube's playback reference. YouTube turns
 *   louder uploads down but never quieter ones up, and `say` writes quiet files, so without this
 *   the video plays noticeably softer than the one before it in somebody's queue.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { CANVAS } from './tutorialCards.mjs'

/** Integrated loudness of the finished mix, in LUFS. YouTube's playback reference. */
const MIX_LUFS = -14
/**
 * The bed's loudness before ducking, in LUFS, with speech at roughly -17. Chosen by ear on the
 * first tutorial: -30, the starting guess, was too faint under Zoe, and -26 sat right.
 */
export const MUSIC_LUFS = -26
/** `loudnorm`'s lookahead, which is what the audio chain is padded by. */
const LOUDNORM_LOOKAHEAD_S = 3
/** The bed's fade-in, in seconds. */
const MUSIC_FADE_IN_S = 1.5
/** The fade-out over the video's last seconds when there is no end card to fade with. */
const FADE_OUT_S = 3

/**
 * The title card over the opening seconds: in over half a second, held through "This is Coda.",
 * and gone before the cursor starts to move under it.
 */
const INTRO = { in: 0.2, inFor: 0.5, out: 3.2, outFor: 0.8 }
/**
 * The end, added after the take: the last frame fades to the canvas colour, then the end card
 * fades in and holds. The music's own fade-out is moved to finish with it.
 */
const OUTRO = { fadeFor: 1.0, cardAt: 0.9, cardFor: 0.8, length: 4.5 }

/**
 * @param {object} take
 * @param {string} take.out      the take's directory, with a trailing slash
 * @param {string} take.name     the tutorial's name, which names the outputs
 * @param {{ start: number, audio: number, say: string, chapter?: string }[]} take.steps
 * @param {string[]} take.clips  one narration file per step
 * @param {number} take.total    the video's length, in seconds
 * @param {{ width: number, height: number, dpr: number }} take.view
 * @param {number} take.fps
 * @param {string} [take.music]  a music file, or nothing for narration alone
 * @param {number} [take.musicLufs]
 * @param {{ intro: string, outro: string }} [take.cards]  from `renderCards`; none, none drawn
 */
export function renderTake({ out, name, steps, clips, total, view, fps, music, musicLufs = MUSIC_LUFS, cards }) {
  // The take plus the end card, which the audio has to cover too.
  const length = total + (cards ? OUTRO.length : 0)
  /*
   * How much longer than the video the audio chain runs before being cut to length. `loudnorm`
   * looks 3 s ahead and drops its last buffer when its input ends, so the final ~2 s of whatever
   * it normalises come out silent — measured on the bed and on the finished mix alike. It was
   * inaudible while every take ended in silence; under an end card with music it cut the music
   * off two seconds early.
   */
  const padded = length + LOUDNORM_LOOKAHEAD_S
  const narration = out + 'narration.wav'
  const delays = steps.map((m, i) => `[${i}]adelay=${Math.round(m.start * 1000)}:all=1[a${i}]`)
  const placed = `${steps.map((_, i) => `[a${i}]`).join('')}amix=inputs=${steps.length}:normalize=0,apad=whole_dur=${padded.toFixed(3)}[out]`
  ffmpeg([
    ...clips.flatMap((c) => ['-i', c]),
    '-filter_complex', [...delays, placed].join(';'),
    '-map', '[out]', '-ar', '48000', narration,
  ])

  const mix = out + 'mix.wav'
  const stereo = 'aformat=sample_rates=48000:channel_layouts=stereo'
  /*
   * The fade-out goes on the finished mix, after `loudnorm`, and never on the bed before it: the
   * normaliser adapts its gain as it goes, so it turned a fading bed straight back up — measured,
   * the music held at full level to within 2.5 s of the end and then dropped out in about one,
   * with the last 1.2 s silent. With an end card it spans the card, starting as the picture fades.
   */
  const fadeStart = cards ? total : Math.max(0, length - FADE_OUT_S)
  const master =
    `loudnorm=I=${MIX_LUFS}:TP=-1.5:LRA=11,aresample=48000,` +
    `afade=t=out:st=${fadeStart.toFixed(3)}:d=${(length - fadeStart).toFixed(3)}`
  if (music) {
    const graph = [
      `[0:a]${stereo},asplit=2[voice][key]`,
      // The track loops (`-stream_loop` below) and is cut to the video's length.
      `[1:a]${stereo},atrim=0:${padded.toFixed(3)},asetpts=N/SR/TB,loudnorm=I=${musicLufs}:TP=-6,` +
        `afade=t=in:d=${MUSIC_FADE_IN_S}[bed]`,
      // Keyed on the voice, so the dip does not depend on the bed's level. Measured on Zoe's
      // narration with a bed at -30, against a steady test tone and against a real track alike:
      // 9 dB of reduction under speech (-30 → -39 LUFS), back to -30 in a pause. The first
      // setting tried, threshold 0.02 and ratio 8, took 16 dB — the music all but vanished under
      // every sentence and leapt back in each half-second gap between steps, which is pumping,
      // not ducking.
      `[bed][key]sidechaincompress=threshold=0.04:ratio=4:attack=25:release=550:knee=4[ducked]`,
      `[voice][ducked]amix=inputs=2:normalize=0,${master}[out]`,
    ]
    ffmpeg([
      '-i', narration,
      '-stream_loop', '-1', '-i', music,
      '-filter_complex', graph.join(';'),
      '-map', '[out]', '-t', length.toFixed(3), mix,
    ])
  } else {
    ffmpeg(['-i', narration, '-af', `${stereo},${master}`, '-t', length.toFixed(3), mix])
  }

  const video = `${out}${name}.mp4`
  const [w, h] = [view.width * view.dpr, view.height * view.dpr]
  // RGB to YUV with the BT.709 matrix, and tagged as such: the default conversion is BT.601,
  // which a player decodes as 709 and every colour shifts slightly — the node category colours
  // most visibly. Last, so the cards are composited in RGB before it.
  const toVideo = `scale=${w}:${h}:flags=lanczos:out_color_matrix=bt709,format=yuv420p`
  const end = total.toFixed(3)
  const graph = cards
    ? [
        // A constant rate first. The capture sends a frame only when the page changes, and the
        // overlay is evaluated once per frame of its main input, so on the nearly static opening
        // the cards' fades were sampled about once a second and snapped on and off.
        `[0:v]fps=${fps},scale=${w}:${h}:flags=lanczos,format=rgba,` +
          `tpad=stop_mode=clone:stop_duration=${OUTRO.length},` +
          `fade=t=out:st=${end}:d=${OUTRO.fadeFor}:color=${CANVAS.replace('#', '0x')}[base]`,
        `[2:v]format=rgba,fade=t=in:st=${INTRO.in}:d=${INTRO.inFor}:alpha=1,` +
          `fade=t=out:st=${INTRO.out}:d=${INTRO.outFor}:alpha=1[intro]`,
        `[base][intro]overlay=0:0:enable='lt(t,${INTRO.out + INTRO.outFor})'[titled]`,
        `[3:v]format=rgba,fade=t=in:st=${(total + OUTRO.cardAt).toFixed(3)}:d=${OUTRO.cardFor}:alpha=1[outro]`,
        `[titled][outro]overlay=0:0:enable='gte(t,${(total + OUTRO.cardAt).toFixed(3)})',${toVideo}[v]`,
      ].join(';')
    : `[0:v]${toVideo}[v]`
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', out + 'frames.txt',
    '-i', mix,
    // The cards are stills, looped for as long as the video runs.
    ...(cards
      ? ['-loop', '1', '-framerate', String(fps), '-t', length.toFixed(3), '-i', cards.intro,
         '-loop', '1', '-framerate', String(fps), '-t', length.toFixed(3), '-i', cards.outro]
      : []),
    '-filter_complex', graph,
    '-map', '[v]', '-map', '1:a',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-fps_mode', 'cfr', '-r', String(fps),
    // A master for upload, not a file for watching: YouTube re-encodes whatever it is given, so
    // the bits are spent here. `stillimage` suits a screen that is mostly static between moves.
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'stillimage',
    '-c:a', 'aac', '-b:a', '192k',
    '-t', length.toFixed(3),
    '-movflags', '+faststart',
    video,
  ])

  writeFileSync(`${out}${name}.srt`, srt(steps))
  writeFileSync(out + 'chapters.txt', chapters(steps))
  return video
}

/** Captions: each step's text split into sentences, its clip's time shared out by length. */
function srt(steps) {
  const cues = []
  for (const step of steps) {
    const sentences = step.say.split(/(?<=[.!?])\s+/).filter(Boolean)
    const chars = sentences.reduce((n, s) => n + s.length, 0)
    let at = step.start
    for (const sentence of sentences) {
      const length = (step.audio * sentence.length) / chars
      cues.push([at, at + length, sentence])
      at += length
    }
  }
  return cues
    .map(([from, to, text], i) => `${i + 1}\n${stamp(from)} --> ${stamp(to)}\n${text}\n`)
    .join('\n')
}

/** YouTube reads chapters off `m:ss Title` lines; the first has to be 0:00. */
function chapters(steps) {
  const lines = steps
    .filter((s) => s.chapter)
    .map((s, i) => `${i === 0 ? '0:00' : clock(s.start)} ${s.chapter}`)
  return lines.join('\n') + '\n'
}

function ffmpeg(argv) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...argv], { stdio: 'inherit' })
}

function stamp(seconds) {
  const ms = Math.round(seconds * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

/** `m:ss`, the form both the console log and YouTube's chapter lines use. */
export function clock(seconds) {
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
