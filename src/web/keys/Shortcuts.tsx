import { Dialog } from "../ui/Dialog.tsx";
import { keyLabel, useKeymap } from "./keymap.tsx";

/** Every command with its keys, grouped; opened with `?`. */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const { commands } = useKeymap();

  const groups = Map.groupBy(
    commands.filter((c) => c.keys?.length),
    (c) => c.group,
  );
  // The same action can be registered by several views; show it once.
  const unique = (list: typeof commands) => [...new Map(list.map((c) => [c.label, c])).values()];

  return (
    <Dialog title="Keyboard shortcuts" className="shortcuts" closeKey="?" onClose={onClose}>
      <div className="shortcut-groups">
        {[...groups.entries()].map(([group, list]) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {unique(list).map((c) => (
                <div key={c.id}>
                  <dt>
                    {c.keys?.map((k) => (
                      <kbd key={k} className="keycap">
                        {keyLabel(k)}
                      </kbd>
                    ))}
                  </dt>
                  <dd>{c.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="dim">
        Esc leaves a text field; Esc again interrupts the selected agent. Tab moves between
        controls.
      </p>
    </Dialog>
  );
}
