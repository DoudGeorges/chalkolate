import { Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

export interface VideoTransportProps {
  videoElRef: React.RefObject<HTMLVideoElement | null>
  onTogglePlayback: () => void
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
  onTogglePlayback,
}: VideoTransportProps) {
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const video = videoElRef.current
    if (!video) return

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
  }, [videoElRef])

  const handleRestart = () => {
    const video = videoElRef.current
    if (!video) return
    video.currentTime = 0
    setCurrentTime(0)
  }

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoElRef.current
    if (!video) return
    const nextTime = Number(event.target.value)
    if (Number.isFinite(nextTime)) {
      video.currentTime = nextTime
      setCurrentTime(nextTime)
    }
  }

  const pct = duration > 0 ? (Math.min(currentTime, duration) / duration) * 100 : 0

  return (
    <div
      role="group"
      aria-label="Video playback controls"
      className="flex w-full max-w-xl items-center gap-2 text-xs"
    >
      <button
        type="button"
        onClick={onTogglePlayback}
        aria-label={playing ? 'Pause video' : 'Play video'}
        title={playing ? 'Pause video' : 'Play video'}
        className="ui-icon rounded-full bg-accent text-white hover:bg-accent-hover hover:text-white"
      >
        {playing ? (
          <Pause className="size-3.5" aria-hidden="true" />
        ) : (
          <Play className="size-3.5 translate-x-[0.5px] fill-current" aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        onClick={handleRestart}
        aria-label="Restart video"
        title="Restart video"
        className="ui-icon"
      >
        <RotateCcw className="size-3.5" aria-hidden="true" />
      </button>

      <input
        type="range"
        min={0}
        max={duration}
        step="any"
        value={Math.min(currentTime, duration)}
        disabled={duration <= 0}
        onChange={handleSeek}
        aria-label="Video position"
        aria-valuetext={formatTime(currentTime) + ' of ' + formatTime(duration)}
        style={{ '--progress': `${pct}%` } as React.CSSProperties}
        className="ui-range min-w-0 flex-1"
      />

      <span className="tabular-nums whitespace-nowrap text-muted">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  )
}
