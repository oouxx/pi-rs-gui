import { ChevronLeft, ChevronRight } from "lucide-react";
import type { MessageBox } from "@/lib/session-versions";

interface VersionSwitcherProps {
  versions: MessageBox;
  disabled: boolean;
  onSelect: (entryId: string, parentKey: string, anchorTop: number) => void;
}

export default function VersionSwitcher({
  versions,
  disabled,
  onSelect,
}: VersionSwitcherProps) {
  const { ids, index, parentKey } = versions;

  const select = (
    event: React.MouseEvent<HTMLButtonElement>,
    nextIndex: number,
  ) => {
    const id = ids[nextIndex];
    if (!id) return;
    const anchor = event.currentTarget.closest<HTMLElement>(
      "[data-version-anchor]",
    );
    onSelect(id, parentKey, anchor?.getBoundingClientRect().top ?? 0);
  };

  return (
    <div
      data-version-anchor={parentKey}
      className="text-subtle-foreground mb-1 flex items-center justify-end gap-0.5 text-[11px] tabular-nums"
    >
      <button
        type="button"
        disabled={disabled || index === 0}
        onClick={(event) => select(event, index - 1)}
        className="hover:text-foreground rounded p-0.5 transition-colors disabled:opacity-30"
        aria-label="previous version"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span>
        {index + 1}/{ids.length}
      </span>
      <button
        type="button"
        disabled={disabled || index === ids.length - 1}
        onClick={(event) => select(event, index + 1)}
        className="hover:text-foreground rounded p-0.5 transition-colors disabled:opacity-30"
        aria-label="next version"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );
}
