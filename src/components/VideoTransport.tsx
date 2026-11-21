import { Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

export interface VideoTransportProps {
  videoElRef: React.RefObject<HTMLVideoElement | null>
  ready: boolean
  onUserSeekOrRestart: () => void
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function VideoTransport({
  videoElRef,
  ready,
  onUserSeekOrRestart,
}: VideoTransportProps) {
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const video = videoElRef.current
    if (!video || !ready) return

    const sync = () => {
      setPlaying(!video.paused && !video.ended)
      setCurrentTime(video.currentTime || 0)
      setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    }

    sync()
    video.addEventListener('play', sync)
    video.addEventListener('pause', sync)
    video.addEventListener('ended', sync)
    video.addEventListener('timeupdate', sync)
    video.addEventListener('durationchange', sync)

    return () => {
      video.removeEventListener('play', sync)
      video.removeEventListener('pause', sync)
      video.removeEventListener('ended', sync)
      video.removeEventListener('timeupdate', sync)
      video.removeEventListener('durationchange', sync)
    }
  }, [ready, videoElRef])

  if (!ready) return null

  const togglePlay = () => {
    const video = videoElRef.current
    if (!video) return
    if (video.paused || video.ended) {
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  }

  const handleRestart = () => {
    const video = videoElRef.current
    if (!video) return
    video.currentTime = 0
    setCurrentTime(0)
    onUserSeekOrRestart()
  }

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoElRef.current
    if (!video) return
    const nextTime = Number(event.target.value)
    if (Number.isFinite(nextTime)) {
      video.currentTime = nextTime
      setCurrentTime(nextTime)
      onUserSeekOrRestart()
    }
  }

  const maxDuration = duration > 0 ? duration : 0.01

  return (
    <div
      aria-label="Video playback controls"
      className="flex items-center gap-2.5 rounded-full border border-line bg-white px-3.5 py-1.5 text-xs shadow-md"
    >
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? 'Pause video' : 'Play video'}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        {playing ? (
          <Pause className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Play className="h-3 w-3 translate-x-[0.5px]" aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        onClick={handleRestart}
        aria-label="Restart video"
        title="Restart video"
        className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <RotateCcw className="h-3 w-3" aria-hidden="true" />
      </button>

      <input
        type="range"
        min={0}
        max={maxDuration}
        step={0.05}
        value={Math.min(currentTime, maxDuration)}
        onChange={handleSeek}
        aria-label="Seek video position"
        className="w-36 sm:w-56 accent-accent cursor-pointer"
      />

      <span className="tabular-nums text-[11px] text-zinc-500 whitespace-nowrap">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  )
}
