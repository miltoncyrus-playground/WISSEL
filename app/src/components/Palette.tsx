import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { matchCommands, type Command } from "../commands";
import { Icon } from "./Icon";

interface PaletteProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
  onRun: (command: Command) => void;
}

/** The command palette: a modal <dialog> (focus is held inside and
 *  Escape closes it, natively) with a combobox over the matches. */
export function Palette({ open, commands, onClose, onRun }: PaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = useMemo(() => matchCommands(query, commands), [query, commands]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      setActive(0);
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    onRun(c);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (matches.length ? (i + 1) % matches.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(matches[active]);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Command palette"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="palette-box">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Search screens, cards and pipelines"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={matches.length ? optionId(active) : undefined}
            placeholder="Jump to, open a card, run a pipeline"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <ul id={listId} role="listbox" aria-label="Matches" className="palette-list">
          {matches.map((c, i) => (
            <li
              key={c.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className="palette-option"
              onMouseMove={() => setActive(i)}
              onClick={() => choose(c)}
            >
              <span className="palette-label">{c.label}</span>
              <span className="palette-hint">{c.hint}</span>
            </li>
          ))}
          {matches.length === 0 && <li className="palette-empty">No matches.</li>}
        </ul>
      </div>
    </dialog>
  );
}
