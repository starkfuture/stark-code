import { useEffect, useState } from "react";
import type {
  EnvironmentId,
  McpServersListInput,
  ProviderDriverKind,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@starkfuture/contracts";
import {
  BlocksIcon,
  FileSearchIcon,
  FolderIcon,
  GithubIcon,
  PaperclipIcon,
  PlusIcon,
  PuzzleIcon,
  SquareSlashIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";
import { ComposerContextPickerDialog } from "./ComposerContextPickerDialog";
import { ComposerIssueLinkDialog } from "./ComposerIssueLinkDialog";
import type { ComposerIssueLink } from "./composerIssueLink";
import { ComposerConnectionsDialog, ComposerConnectorsMenu } from "./ComposerConnectorsMenu";
import { ComposerSkillsDialog } from "./ComposerSkillsDialog";
import { ComposerSlashCommandsDialog } from "./ComposerSlashCommandsDialog";

/** This menu edits a draft or opens provider controls; it never submits a turn. */
export function ComposerAddMenu({
  environmentId,
  target,
  providerKind,
  providerLabel,
  cwd,
  disabled,
  canAttach,
  canAddContext,
  skills,
  commands,
  catalogPending,
  onAttach,
  onInsertPath,
  onInsertIssue,
  onInsertSkill,
  onInsertCommand,
  onCatalogOpenChange,
}: {
  environmentId: EnvironmentId;
  target: McpServersListInput | null;
  providerKind: ProviderDriverKind;
  providerLabel: string;
  cwd: string | null;
  disabled: boolean;
  canAttach: boolean;
  canAddContext: boolean;
  skills: ReadonlyArray<ServerProviderSkill>;
  commands: ReadonlyArray<ServerProviderSlashCommand>;
  catalogPending: boolean;
  onAttach: () => void;
  onInsertPath: (path: string) => boolean;
  onInsertIssue: (link: ComposerIssueLink) => boolean;
  onInsertSkill: (skill: ServerProviderSkill) => boolean;
  onInsertCommand: (command: ServerProviderSlashCommand) => boolean;
  onCatalogOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [dialog, setDialog] = useState<
    "file" | "directory" | "issue" | "commands" | "skills" | "connections" | null
  >(null);
  const mcpProvider =
    providerKind === "claudeAgent" ? "claudeAgent" : providerKind === "codex" ? "codex" : null;
  const catalogOpen = open || dialog === "commands" || dialog === "skills";
  useEffect(() => {
    onCatalogOpenChange(catalogOpen);
    return () => onCatalogOpenChange(false);
  }, [catalogOpen, onCatalogOpenChange]);
  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setDialog(null);
    setConnectorsOpen(false);
  }, [disabled]);
  const openDialog = (next: Exclude<typeof dialog, null>) => {
    setOpen(false);
    setDialog(next);
  };
  const closeDialog = (value: boolean) => {
    if (!value) setDialog(null);
  };
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Add context and tools"
              disabled={disabled}
            />
          }
        >
          <PlusIcon />
        </MenuTrigger>
        <MenuPopup
          {...composerFloatingLayerProps}
          side="top"
          align="end"
          finalFocus={dialog ? false : undefined}
        >
          <MenuItem disabled={!canAttach} onClick={onAttach}>
            <PaperclipIcon />
            Add files or photos
          </MenuItem>
          <MenuItem disabled={!canAddContext || !cwd} onClick={() => openDialog("file")}>
            <FileSearchIcon />
            Reference workspace file
          </MenuItem>
          <MenuItem disabled={!canAddContext || !cwd} onClick={() => openDialog("directory")}>
            <FolderIcon />
            Add folder
          </MenuItem>
          <MenuItem disabled={!canAddContext} onClick={() => openDialog("issue")}>
            <GithubIcon />
            Add GitHub issue link
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!canAddContext} onClick={() => openDialog("commands")}>
            <SquareSlashIcon />
            Slash commands
          </MenuItem>
          {mcpProvider && target ? (
            <MenuSub open={connectorsOpen} onOpenChange={setConnectorsOpen}>
              <MenuSubTrigger disabled={!canAddContext}>
                <BlocksIcon />
                Connectors
              </MenuSubTrigger>
              <ComposerConnectorsMenu
                environmentId={environmentId}
                target={target}
                providerKind={mcpProvider}
                providerLabel={providerLabel}
                open={open && connectorsOpen}
                onManage={() => openDialog("connections")}
              />
            </MenuSub>
          ) : null}
          <MenuItem disabled={!canAddContext} onClick={() => openDialog("skills")}>
            <PuzzleIcon />
            Skills &amp; plugins
          </MenuItem>
        </MenuPopup>
      </Menu>
      {cwd && (dialog === "file" || dialog === "directory") ? (
        <ComposerContextPickerDialog
          open
          onOpenChange={closeDialog}
          environmentId={environmentId}
          cwd={cwd}
          kind={dialog}
          onSelect={onInsertPath}
        />
      ) : null}
      {dialog === "issue" ? (
        <ComposerIssueLinkDialog open onOpenChange={closeDialog} onSelect={onInsertIssue} />
      ) : null}
      {dialog === "commands" ? (
        <ComposerSlashCommandsDialog
          open
          onOpenChange={closeDialog}
          providerLabel={providerLabel}
          commands={commands}
          isPending={catalogPending}
          onSelect={onInsertCommand}
        />
      ) : null}
      {dialog === "skills" ? (
        <ComposerSkillsDialog
          open
          onOpenChange={closeDialog}
          providerKind={providerKind}
          providerLabel={providerLabel}
          skills={skills}
          isPending={catalogPending}
          onSelect={onInsertSkill}
        />
      ) : null}
      {dialog === "connections" && mcpProvider && target ? (
        <ComposerConnectionsDialog
          open
          onOpenChange={closeDialog}
          environmentId={environmentId}
          target={target}
          providerKind={mcpProvider}
          providerLabel={providerLabel}
        />
      ) : null}
    </>
  );
}
