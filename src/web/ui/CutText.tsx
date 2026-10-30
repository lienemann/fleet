import { type ReactNode, useState } from "react";
import { TEXT_LIMIT } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";

/**
 * Text the state keeps cut to TEXT_LIMIT characters. While it is cut, a note says so and offers the
 * whole text from the log, which the daemon has in full. `render` draws whichever text is current.
 */
export function CutText({
  agent,
  seq,
  text,
  cut,
  render,
}: {
  agent: string;
  /** The log line the text came from; without it there is nothing to fetch. */
  seq: number | undefined;
  text: string;
  cut: boolean;
  render: (text: string) => ReactNode;
}) {
  const { call } = useFleet();
  const [whole, setWhole] = useState<string>();
  const [missing, setMissing] = useState(false);
  const load = () => {
    if (seq === undefined) return;
    call({ type: "log_text", agent, seq }).then(
      (found) => (found === null ? setMissing(true) : setWhole(found)),
      () => setMissing(true),
    );
  };
  return (
    <>
      {render(whole ?? text)}
      {cut && whole === undefined && (
        <p className="dim cut-note">
          … cut off at {TEXT_LIMIT.toLocaleString("en-US")} characters.{" "}
          {missing || seq === undefined ? (
            "The rest is not available."
          ) : (
            <button type="button" className="link accent" onClick={load}>
              Show all
            </button>
          )}
        </p>
      )}
    </>
  );
}
