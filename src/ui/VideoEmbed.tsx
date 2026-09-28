/**
 * A video that loads nothing from YouTube until somebody presses play.
 *
 * The Data & Privacy dialog says Coda counts page views and nothing else: no cookies, nothing
 * kept in the browser. An ordinary embed breaks that on sight — the player is Google's code, and
 * it arrives with its cookies and trackers the moment the frame mounts, which on the first-visit
 * dialog means for every new visitor whether or not they watch. So the frame is **not mounted**
 * until the press: before it, this is a local poster and a button; after it, the privacy-enhanced
 * player (`embedUrl`), which starts at once because the press was the request to play.
 *
 * The note under the poster says where the video comes from before anything is loaded, which is
 * the one moment a reader can still decide not to.
 */

import { useState } from 'react'

import type { Video } from './videos'
import { embedUrl, watchUrl } from './videos'

export function VideoEmbed({ video }: { video: Video }) {
  const [playing, setPlaying] = useState(false)
  return (
    <figure className="video">
      <div className="video__frame">
        {playing ? (
          <iframe
            className="video__player"
            src={embedUrl(video)}
            title={video.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            className="video__poster"
            onClick={() => setPlaying(true)}
            aria-label={`Play video: ${video.title} (${video.duration})`}
          >
            <img src={video.poster} alt="" />
            <span className="video__play" aria-hidden="true" />
            <span className="video__time" aria-hidden="true">
              {video.duration}
            </span>
          </button>
        )}
      </div>
      <figcaption className="video__note">
        {playing ? 'Playing from YouTube.' : 'Plays from YouTube once you press play.'}{' '}
        <a href={watchUrl(video)} target="_blank" rel="noreferrer noopener">
          Watch on YouTube ↗
        </a>
      </figcaption>
    </figure>
  )
}
