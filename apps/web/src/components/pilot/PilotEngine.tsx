import type { PilotEngine, PilotSettings } from "@starkfuture/contracts";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { ENGINE_LABELS, codexPlanLabel } from "./pilot.logic";

const ENGINES = ["claude", "codex"] as const satisfies readonly PilotEngine[];

const isEngine = (value: unknown): value is PilotEngine => value === "claude" || value === "codex";

/** Codex always says it uses the person's plan; an engine that cannot run says why. */
function engineDetail(settings: PilotSettings | null, engine: PilotEngine): string | null {
  const state = settings?.engines[engine];
  if (engine === "codex") {
    if (!state) return "Uses your Codex plan";
    return state.available
      ? codexPlanLabel(settings.engines.codex)
      : `Uses your Codex plan. ${state.note ?? "Not available right now."}`;
  }
  return state && !state.available ? (state.note ?? "Not available right now.") : null;
}

/** Claude and Codex as menu choices; an engine that cannot run is disabled unless already chosen. */
function EngineChoices({
  settings,
  value,
  label,
  onChoose,
}: {
  settings: PilotSettings | null;
  value: PilotEngine;
  label: string;
  onChoose: (engine: PilotEngine) => void;
}) {
  return (
    <MenuGroup>
      <MenuGroupLabel>{label}</MenuGroupLabel>
      <MenuRadioGroup
        value={value}
        onValueChange={(next) => {
          if (isEngine(next) && next !== value) onChoose(next);
        }}
      >
        {ENGINES.map((engine) => {
          const detail = engineDetail(settings, engine);
          const available = settings?.engines[engine].available ?? true;
          return (
            <MenuRadioItem
              key={engine}
              value={engine}
              closeOnClick
              disabled={!available && engine !== value}
            >
              <span className="flex items-center gap-3">
                <span className="min-w-0 flex-1 py-0.5">
                  <span className="block">{ENGINE_LABELS[engine]}</span>
                  {detail ? (
                    <span className="block text-xs leading-snug text-muted-foreground">
                      {detail}
                    </span>
                  ) : null}
                </span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
    </MenuGroup>
  );
}

/**
 * The composer's engine control, "Claude ▾" beside Send. It picks the engine
 * for the next question only; the default lives in the "…" menu. It renders
 * from the status before Pilot reports which engines can run, so the
 * composer never changes size.
 */
export function PilotEngineMenu({
  settings,
  chosen,
  onChoose,
}: {
  settings: PilotSettings | null;
  chosen: PilotEngine;
  onChoose: (engine: PilotEngine) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={`Engine for the next question: ${ENGINE_LABELS[chosen]}`}
            disabled={settings === null}
          />
        }
      >
        {ENGINE_LABELS[chosen]}
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup side="top" align="end" positionMethod="fixed">
        <div className="w-60 max-w-[calc(100vw-3rem)]">
          <EngineChoices
            settings={settings}
            value={chosen}
            label="Next question"
            onChoose={onChoose}
          />
        </div>
      </MenuPopup>
    </Menu>
  );
}

/** The default engine, in the "…" menu. */
export function PilotEngineMenuGroup({
  settings,
  onChoose,
}: {
  settings: PilotSettings;
  onChoose: (engine: PilotEngine) => void;
}) {
  return (
    <EngineChoices
      settings={settings}
      value={settings.engine}
      label="Thinks with"
      onChoose={onChoose}
    />
  );
}
