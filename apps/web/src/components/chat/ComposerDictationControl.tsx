import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useComposerDictation } from "./useComposerDictation";
import { composerFloatingLayerProps } from "./composerEventScope";

export function ComposerDictationControl({
  voice,
  disabled,
}: {
  voice: ReturnType<typeof useComposerDictation>;
  disabled: boolean;
}) {
  if (!voice.supported) return null;
  const label = voice.busy
    ? voice.state.phase === "recording"
      ? "Finish dictation"
      : voice.state.phase === "preparing"
        ? "Preparing dictation"
        : "Transcribing"
    : voice.available
      ? "Dictate a message"
      : voice.unavailableReason;
  return (
    <>
      {voice.busy ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel dictation"
          onPointerDown={(event) => event.preventDefault()}
          onClick={voice.cancel}
        >
          <XIcon />
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-composer-dictation="true"
              aria-label={label}
              aria-pressed={voice.busy}
              disabled={
                voice.busy ? voice.state.phase !== "recording" : disabled || !voice.available
              }
              onPointerDown={(event) => event.preventDefault()}
              onClick={voice.busy ? voice.stop : voice.start}
            />
          }
        >
          {voice.busy ? <CheckIcon /> : <MicIcon />}
        </TooltipTrigger>
        <TooltipPopup {...composerFloatingLayerProps}>{label}</TooltipPopup>
      </Tooltip>
    </>
  );
}
