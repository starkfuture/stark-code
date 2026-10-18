import type { VoiceInputState } from "@starkfuture/client-runtime/voice-input";
import { memo, useEffect, useState, useSyncExternalStore } from "react";
import type { NativeDictationMeter } from "./nativeDictationMeter";

type DictationPhase = VoiceInputState["phase"];
const SAMPLE_COUNT = 24;

const RecordingTime = memo(function RecordingTime({
  phase,
  startedAt,
  stoppedAt,
}: {
  phase: DictationPhase;
  startedAt: number;
  stoppedAt: number | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (phase !== "recording" || stoppedAt !== null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase, stoppedAt]);
  const seconds = Math.max(0, Math.floor(((stoppedAt ?? now) - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return (
    <span role="timer" aria-live="off" className="shrink-0 tabular-nums">
      <span className="sr-only">Recording duration: </span>
      {minutes}:{remainder}
    </span>
  );
});

/** Only this small indicator subscribes to microphone samples; the editor stays still. */
export function ComposerDictationStatus({
  phase,
  meter,
}: {
  phase: DictationPhase;
  meter: NativeDictationMeter;
}) {
  const snapshot = useSyncExternalStore(meter.subscribe, meter.getSnapshot, meter.getSnapshot);
  if (phase === "idle" || phase === "error") return null;
  const startedAt = phase === "preparing" ? null : snapshot.startedAt;
  const padding = SAMPLE_COUNT - snapshot.levels.length;
  return (
    <div
      data-composer-dictation-status="true"
      className="flex min-w-0 items-center gap-2 px-3 pb-2 text-xs text-muted-foreground sm:px-4"
    >
      <span role="status" aria-live="polite" aria-atomic="true" className="shrink-0">
        {phase === "recording"
          ? "Listening"
          : phase === "preparing"
            ? "Preparing dictation…"
            : "Transcribing…"}
      </span>
      {startedAt !== null ? (
        <>
          <span
            aria-hidden="true"
            data-dictation-waveform="true"
            className={`flex h-5 w-24 min-w-12 shrink items-center gap-0.5 ${phase === "recording" ? "text-primary" : "text-muted-foreground"}`}
          >
            {Array.from({ length: SAMPLE_COUNT }, (_, index) => {
              const level = snapshot.levels[index - padding] ?? 0;
              return (
                <span
                  key={index}
                  className="min-w-0 flex-1 rounded-full bg-current"
                  style={{ height: `${2 + level * 16}px`, opacity: index < padding ? 0.25 : 1 }}
                />
              );
            })}
          </span>
          <RecordingTime
            key={startedAt}
            phase={phase}
            startedAt={startedAt}
            stoppedAt={snapshot.stoppedAt}
          />
        </>
      ) : null}
    </div>
  );
}
