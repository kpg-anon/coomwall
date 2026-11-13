// A streamed link's sound comes as a separate stream (YouTube above 360p):
// an <audio> beside the <video>, which this keeps in step with the picture.
// The video leads; the audio follows its play, pause, speed and position.
//
// Small drift is left alone: re-seeking a remote stream starts a new range
// request, and doing that on every timeupdate keeps a slow stream silent. A
// seek is made when the two are more than 1 s apart, at most every 2 s,
// and always right after the video itself seeks (a loop, the viewer's
// arrows).

const DRIFT = 1;
const COOLDOWN_MS = 2000;

/** Start following; returns a function that stops it. */
export function followVideo(video: HTMLVideoElement, audio: HTMLAudioElement): () => void {
  let lastSeek = -Infinity;

  const align = (force: boolean) => {
    const now = performance.now();
    if (Math.abs(audio.currentTime - video.currentTime) > DRIFT && (force || now - lastSeek > COOLDOWN_MS)) {
      lastSeek = now;
      audio.currentTime = video.currentTime;
    }
  };

  const step = () => {
    if (audio.playbackRate !== video.playbackRate) audio.playbackRate = video.playbackRate;
    if (video.paused) {
      if (!audio.paused) audio.pause();
      return;
    }
    align(false);
    // an audio stream that ended (shorter than the video) is not restarted
    // from 0 unless it loops with the video
    if (audio.paused && !(audio.ended && !audio.loop)) audio.play().catch(() => {});
  };
  const seeked = () => {
    align(true);
    step();
  };

  const events = ["play", "pause", "playing", "timeupdate", "ratechange", "waiting"] as const;
  for (const e of events) video.addEventListener(e, step);
  video.addEventListener("seeked", seeked);
  step();
  return () => {
    for (const e of events) video.removeEventListener(e, step);
    video.removeEventListener("seeked", seeked);
    audio.pause();
  };
}
