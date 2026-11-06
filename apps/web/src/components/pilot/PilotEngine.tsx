import type { PilotEngine, PilotSettings } from "@starkfuture/contracts";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ENGINE_LABELS, codexPlanLabel, engineHint } from "./pilot.logic";

const ENGINES = ["claude", "codex"] as const satisfies readonly PilotEngine[];

const isEngine = (value: unknown): value is PilotEngine => value === "claude" || value === "codex";

/**
 * The composer's Claude / Codex switch. It picks the engine for the next
 * question only; the default stays in the "…" menu. An engine that cannot run
 * is disabled, and the line beside the switch says why.
 */
export function PilotEngineSwitch({
  settings,
  chosen,
  onChoose,
}: {
  settings: PilotSettings;
  chosen: PilotEngine;
  onChoose: (engine: PilotEngine) => void;
}) {
  const hint = engineHint(settings, chosen);
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <ToggleGroup
        aria-label="Engine for the next question"
        variant="segmented"
        value={[chosen]}
        onValueChange={(next) => {
          if (isEngine(next[0])) onChoose(next[0]);
        }}
      >
        {ENGINES.map((engine) => (
          <Toggle
            key={engine}
            value={engine}
            disabled={!settings.engines[engine].available && engine !== chosen}
          >
            {ENGINE_LABELS[engine]}
          </Toggle>
        ))}
      </ToggleGroup>
      {hint ? (
        <span className="min-w-0 text-xs break-words text-muted-foreground">{hint}</span>
      ) : null}
    </div>
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
    <MenuGroup>
      <MenuGroupLabel>Thinks with</MenuGroupLabel>
      <MenuRadioGroup
        value={settings.engine}
        onValueChange={(value) => {
          if (isEngine(value) && value !== settings.engine) onChoose(value);
        }}
      >
        {ENGINES.map((engine) => {
          const state = settings.engines[engine];
          const detail =
            engine === "codex" && state.available
              ? codexPlanLabel(settings.engines.codex)
              : engine === "codex"
                ? `Uses your Codex plan. ${state.note ?? "Not available right now."}`
                : state.available
                  ? null
                  : (state.note ?? "Not available right now.");
          return (
            <MenuRadioItem
              key={engine}
              value={engine}
              closeOnClick
              disabled={!state.available && engine !== settings.engine}
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
