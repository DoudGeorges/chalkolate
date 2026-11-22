import { TALKATIVENESS_OPTIONS, Talkativeness } from "../lib/voicePreferences";

export interface TalkativenessPickerProps {
  value: Talkativeness;
  onChange: (value: Talkativeness) => void;
}

function LevelBars({ level, active }: { level: number; active: boolean }) {
  return (
    <span className="flex h-3.5 items-end gap-[3px]" aria-hidden="true">
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={`w-[3px] rounded-full transition-colors ${
            bar <= level
              ? active
                ? "bg-accent"
                : "bg-zinc-400"
              : "bg-zinc-200"
          }`}
          style={{ height: `${4 + bar * 3}px` }}
        />
      ))}
    </span>
  );
}

/** Brief / Standard / Detailed selector for how much is said about each mistake. */
export function TalkativenessPicker({
  value,
  onChange,
}: TalkativenessPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Talkativeness"
      className="grid grid-cols-3 gap-1.5"
    >
      {TALKATIVENESS_OPTIONS.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            onClick={() => onChange(option.id)}
            className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              selected
                ? "border-accent bg-accent/[0.08] text-zinc-900"
                : "border-line bg-zinc-50 text-zinc-500 hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-800"
            }`}
          >
            <LevelBars level={option.level} active={selected} />
            <span className="text-[11px] font-medium leading-none">
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
