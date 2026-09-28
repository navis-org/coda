/**
 * The video tutorials and the channel they live on: one table, read by every surface that
 * offers them — the first-visit guides dialog, the `?` menu, the welcome page.
 *
 * A table rather than a URL typed into each, for the reason `TOURS` gives about itself: several
 * surfaces offer the same thing, and each writing its own words (or its own link) for it is how
 * one of them ends up pointing at last year's upload.
 *
 * The poster is a still from the video shipped in `public/`, not YouTube's thumbnail, because a
 * thumbnail from `i.ytimg.com` is a request to Google on sight — see `VideoEmbed` for why nothing
 * here may make one before somebody presses play.
 */

export const CHANNEL_URL = 'https://www.youtube.com/@coda-science'

export interface Video {
  /** YouTube's id, the part after `youtu.be/`. */
  id: string
  title: string
  /** As YouTube shows it, `m:ss`. */
  duration: string
  /** A local still, under `public/`. */
  poster: string
}

export const FIRST_WORKFLOW: Video = {
  id: '4s2zeBkXudo',
  title: 'Your first workflow',
  duration: '2:22',
  poster: `${import.meta.env.BASE_URL}video/first-workflow.jpg`,
}

/** The video's page on YouTube, for a link that leaves the app. */
export function watchUrl(video: Video): string {
  return `https://youtu.be/${video.id}`
}

/**
 * The player, on YouTube's privacy-enhanced host: `youtube-nocookie.com` sets no cookie until the
 * video is played, which in `VideoEmbed` is the same moment it is loaded at all. `autoplay`
 * because the frame is only ever mounted by a press of play, so a second press would be a
 * question already answered; `rel=0` keeps the end screen to this channel's own videos.
 */
export function embedUrl(video: Video): string {
  return `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`
}
