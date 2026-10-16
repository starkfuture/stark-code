import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export interface WorkspaceToolsMenuAction {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  active?: boolean;
  onSelect: () => void;
}

export interface WorkspaceToolsMenuProps {
  groups: readonly {
    label: string;
    actions: readonly WorkspaceToolsMenuAction[];
  }[];
  connections?: ReactNode;
}

export function WorkspaceToolsMenu({ groups, connections }: WorkspaceToolsMenuProps) {
  const visibleGroups = groups.filter((group) => group.actions.length > 0);

  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="sm" aria-label="Tools" />}>
        Tools
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" positionMethod="fixed">
        <div className="w-80 max-w-[calc(100vw-3rem)]">
          {visibleGroups.map((group, index) => (
            <Fragment key={group.label}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroup>
                <MenuGroupLabel>{group.label}</MenuGroupLabel>
                {group.actions.map((action) => (
                  <MenuItem
                    key={action.id}
                    aria-label={action.label}
                    aria-current={action.active ? "true" : undefined}
                    disabled={action.disabled}
                    closeOnClick
                    onClick={action.onSelect}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
                      <span>{action.label}</span>
                      {action.description ? (
                        <span className="text-xs leading-snug text-muted-foreground">
                          {action.description}
                        </span>
                      ) : null}
                    </span>
                    {action.active ? <CheckIcon aria-hidden /> : null}
                  </MenuItem>
                ))}
              </MenuGroup>
            </Fragment>
          ))}
          {connections ? (
            <>
              {visibleGroups.length > 0 ? <MenuSeparator /> : null}
              <MenuGroup>
                <MenuGroupLabel>Connections</MenuGroupLabel>
                <div className="px-2 py-1">{connections}</div>
              </MenuGroup>
            </>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}
