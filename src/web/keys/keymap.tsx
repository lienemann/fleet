import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * One action of the UI. Every command shows up in the shortcut overlay and the palette,
 * so anything reachable by mouse is reachable by keyboard and can be looked up.
 */
export interface Command {
  id: string;
  label: string;
  group: string;
  /** Key sequences, e.g. "g b", "shift+a", "mod+k". The first one is shown. */
  keys?: string[];
  /** Hidden from the palette, e.g. j/k which make no sense there. */
  paletteHidden?: boolean;
  /** Also fires while typing in a field. */
  global?: boolean;
  /**
   * The pane the command belongs to. It only fires while the focus is inside that pane, and
   * then wins over a command with the same keys that has no pane.
   */
  scope?: Pane;
  run: () => void;
}

/** The regions of the UI that own keys: the view in the middle, the drawer, the rail. */
export const PANES = ["rail", "main", "drawer"] as const;
export type Pane = (typeof PANES)[number];

interface Keymap {
  commands: Command[];
  register: (owner: string, commands: Command[]) => void;
  unregister: (owner: string) => void;
  /** First key of a chord in progress, e.g. "g". */
  pending: string | undefined;
}

const KeymapContext = createContext<Keymap | undefined>(undefined);

const CHORD_TIMEOUT_MS = 1500;

/** The only plain keys that are letters or signs: they walk lists, and never start anything. */
const LIST_KEYS = new Set(["j", "k", "[", "]"]);

/**
 * Whether a key sequence may be registered. Keys typed while the focus is somewhere unexpected
 * must never start anything, so a letter, digit or sign takes Option (or Cmd), except the keys
 * that only walk lists. Later strokes of a chord are plain, as the first one was deliberate.
 */
export function isSafeKey(sequence: string): boolean {
  const parts = (sequence.split(" ")[0] ?? "").split("+");
  const key = parts.at(-1) ?? "";
  return (
    parts.includes("alt") ||
    parts.includes("mod") ||
    key.length > 1 ||
    LIST_KEYS.has(key) ||
    key === "?"
  );
}

/** The pane that holds the focus, if any. */
const focusedPane = (): Pane | undefined => {
  const pane = document.activeElement?.closest<HTMLElement>("[data-pane]")?.dataset.pane;
  return PANES.find((p) => p === pane);
};

/** Puts the focus into a pane, if it is on screen. */
export function focusPaneNamed(pane: Pane): void {
  document.querySelector<HTMLElement>(`[data-pane="${pane}"]`)?.focus();
}

/** Moves the focus to the next or previous pane that is on screen. */
export function focusPane(step: 1 | -1): void {
  const panes = [...document.querySelectorAll<HTMLElement>("[data-pane]")];
  if (panes.length === 0) return;
  const current = panes.findIndex((p) => p.contains(document.activeElement));
  const next = panes[(current + step + panes.length) % panes.length];
  next?.focus();
}
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Option turns letters into other characters on the Mac, so with Alt held the physical key counts. */
const physicalKey = (event: KeyboardEvent): string =>
  /^(?:Key|Digit)(.)$/.exec(event.code)?.[1]?.toLowerCase() ??
  SIGNS[event.code] ??
  event.key.toLowerCase();
const SIGNS: Record<string, string> = { Equal: "=", Minus: "-" };

/** Normalises a key event to "mod+shift+k" form; shift only shows for letters and named keys. */
export function keyName(event: KeyboardEvent): string {
  const key = event.altKey ? physicalKey(event) : event.key.toLowerCase();
  const mods: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) mods.push("mod");
  if (event.altKey) mods.push("alt");
  const letterOrNamed = /^[a-z]$/.test(key) || event.key.length > 1;
  if (event.shiftKey && letterOrNamed) mods.push("shift");
  return [...mods, key].join("+");
}

/** How a key sequence is shown: "mod+k" as "⌘K", "shift+a" as "⇧A", "g b" unchanged. */
export function keyLabel(sequence: string): string {
  return sequence
    .split(" ")
    .map((stroke) =>
      stroke
        .replace("mod+", isMac ? "⌘" : "Ctrl+")
        .replace("shift+", "⇧")
        .replace("alt+", isMac ? "⌥" : "Alt+")
        .replace("escape", "Esc")
        .replace("arrowleft", "←")
        .replace("arrowright", "→")
        .replace("enter", "↵")
        .replace(
          /(^|[⌘⇧⌥+])([a-z])$/,
          (_, mod, letter: string) => mod + (mod ? letter.toUpperCase() : letter),
        ),
    )
    .join(" ");
}

const typingIn = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable]");

export function KeymapProvider({ children }: { children: ReactNode }) {
  const [owners, setOwners] = useState<Array<[string, Command[]]>>([]);
  const [pending, setPending] = useState<string>();
  const pendingRef = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Later registrations win, so a view's j/k overrides the global ones while it is mounted.
  const commands = useMemo(() => owners.flatMap(([, list]) => list), [owners]);
  const latest = useRef(commands);
  latest.current = commands;

  const register = useCallback((owner: string, list: Command[]) => {
    setOwners((prev) => {
      const index = prev.findIndex(([o]) => o === owner);
      if (index === -1) return [...prev, [owner, list]];
      const next = [...prev];
      next[index] = [owner, list];
      return next;
    });
  }, []);
  const unregister = useCallback(
    (owner: string) => setOwners((prev) => prev.filter(([o]) => o !== owner)),
    [],
  );

  useEffect(() => {
    const setChord = (value: string | undefined): void => {
      pendingRef.current = value;
      setPending(value);
      clearTimeout(timer.current);
      if (value) timer.current = setTimeout(() => setChord(undefined), CHORD_TIMEOUT_MS);
    };

    const onKey = (event: KeyboardEvent): void => {
      if (
        event.isComposing ||
        ["shift", "control", "alt", "meta"].includes(event.key.toLowerCase())
      )
        return;
      // An open dialog owns the keyboard: Esc closes it, and nothing behind it reacts.
      if (document.querySelector("dialog[open]")) return;
      const typing = typingIn(event.target);
      const stroke = keyName(event);
      // Option may still be down for the second stroke of a chord.
      const sequences = pendingRef.current
        ? [
            `${pendingRef.current} ${stroke}`,
            `${pendingRef.current} ${stroke.replace(/^alt\+/, "")}`,
          ]
        : [stroke];
      const sequence = sequences[0] ?? stroke;
      // A plain key works only from inside a pane, not while the focus is on the page. Option keys
      // belong to the main view then, so a key pressed right after loading still reaches it.
      const plain = !pendingRef.current && !/^(?:mod|alt)\+/.test(stroke) && stroke !== "?";
      const pane = focusedPane();
      const candidates = latest.current.filter(
        (c) =>
          (!typing || c.global) && (!c.scope || c.scope === (pane ?? "main")) && !(plain && !pane),
      );

      // A command of the focused pane beats one without a pane; otherwise the later one wins.
      const match = candidates
        .filter((c) => c.keys?.some((k) => sequences.includes(k)))
        .reduce<Command | undefined>(
          (best, c) => (Number(!!c.scope) >= Number(!!best?.scope) ? c : best),
          undefined,
        );
      const isPrefix = candidates.some((c) => c.keys?.some((k) => k.startsWith(`${sequence} `)));
      // A button clicked earlier keeps the focus; after a shortcut, the browser would frame it.
      if ((match || isPrefix) && event.target instanceof HTMLButtonElement) event.target.blur();
      if (match) {
        event.preventDefault();
        setChord(undefined);
        match.run();
        return;
      }
      if (isPrefix && !pendingRef.current) {
        event.preventDefault();
        setChord(stroke);
        return;
      }
      if (typing && event.key === "Escape") {
        // Leaving a field is the first step; a second Esc reaches the commands.
        (event.target as HTMLElement).blur();
        return;
      }
      setChord(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer.current);
    };
  }, []);

  const value = useMemo(
    () => ({ commands, register, unregister, pending }),
    [commands, register, unregister, pending],
  );
  return <KeymapContext.Provider value={value}>{children}</KeymapContext.Provider>;
}

export function useKeymap(): Keymap {
  const keymap = useContext(KeymapContext);
  if (!keymap) throw new Error("useKeymap outside KeymapProvider");
  return keymap;
}

/**
 * Registers commands while the calling component is mounted. Handlers may close over
 * fresh state: the latest list is re-registered on every render.
 */
export function useCommands(commands: Command[]): void {
  const owner = useId();
  const { register, unregister } = useKeymap();
  for (const key of commands.flatMap((c) => c.keys ?? []))
    if (!isSafeKey(key)) throw new Error(`The key "${key}" needs Option, or Cmd`);
  const signature = commands.map((c) => `${c.id}:${c.label}:${c.keys?.join(",")}`).join("|");
  const latest = useRef(commands);
  latest.current = commands;

  // Before paint, so a key pressed as soon as a view shows reaches its commands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-register only when the visible shape changes
  useLayoutEffect(() => {
    register(
      owner,
      latest.current.map((c) => ({
        ...c,
        run: () => latest.current.find((l) => l.id === c.id)?.run(),
      })),
    );
  }, [owner, register, signature]);
  useLayoutEffect(() => () => unregister(owner), [owner, unregister]);
}
