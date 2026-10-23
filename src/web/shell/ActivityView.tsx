import { useState } from "react";
import type { AgentView, LogLine } from "../../shared/reducer.ts";

/** Finished calls shown before "Show more". */
const FINISHED_SHOWN = 15;
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);

interface Call {
  id: string;
  title: string;
  tool: string;
  input: string;
  output?: string;
  /** Calls a subagent made, for subagents. */
  steps: Call[];
}

/** Pairs each tool call in the transcript with its result, and gathers each subagent's own calls. */
export function collectCalls(log: readonly LogLine[]): Call[] {
  const calls = new Map<string, Call & { parent: string | null }>();
  for (const line of log) {
    if (line.role === "tool_use" && line.toolUseId) {
      calls.set(line.toolUseId, {
        id: line.toolUseId,
        title: line.title ?? `${line.toolName ?? "Tool"} ${line.text}`,
        tool: line.toolName ?? "",
        input: line.text,
        parent: line.parent,
        steps: [],
      });
    } else if (line.role === "tool_result" && line.toolUseId) {
      const call = calls.get(line.toolUseId);
      if (call) call.output = line.text;
    }
  }
  const top: Call[] = [];
  for (const call of calls.values()) {
    const parent = call.parent ? calls.get(call.parent) : undefined;
    if (parent) parent.steps.push(call);
    else top.push(call);
  }
  return top;
}

/**
 * What the session runs and ran: subagents with their steps, and every tool call with its
 * input and output, newest first. Like the background tasks panel of the Claude desktop app.
 */
export function ActivityView({ agent }: { agent: AgentView }) {
  const [all, setAll] = useState(false);
  const calls = collectCalls(agent.log).reverse();
  const running = calls.filter((c) => c.output === undefined);
  const finished = calls.filter((c) => c.output !== undefined);
  const shown = all ? finished : finished.slice(0, FINISHED_SHOWN);

  return (
    <div className="drawer-scroll activity">
      {agent.backgroundTasks.length > 0 && (
        <section>
          <h3>Background</h3>
          {agent.backgroundTasks.map((task) => (
            <div key={task.id} className="call">
              <span className="call-title">{task.description}</span>
              <span className="dim">{task.type}</span>
            </div>
          ))}
        </section>
      )}
      <section>
        <h3>Running</h3>
        {running.length === 0 && <p className="empty">Nothing right now.</p>}
        {running.map((call) => (
          <CallRow key={call.id} call={call} open />
        ))}
      </section>
      <section>
        <h3>Finished · {finished.length}</h3>
        {shown.map((call) => (
          <CallRow key={call.id} call={call} />
        ))}
        {finished.length > FINISHED_SHOWN && (
          <button type="button" className="link dim" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show ${finished.length - FINISHED_SHOWN} more`}
          </button>
        )}
      </section>
    </div>
  );
}

function CallRow({ call, open = false }: { call: Call; open?: boolean }) {
  const subagent = SUBAGENT_TOOLS.has(call.tool);
  const done = call.steps.filter((s) => s.output !== undefined).length;
  return (
    <details className="call" open={open && subagent}>
      <summary>
        <span className="call-title">{call.title}</span>
        {subagent && call.steps.length > 0 && (
          <span className="dim">
            {done}/{call.steps.length} steps
          </span>
        )}
      </summary>
      {subagent ? (
        <div className="steps">
          {call.steps.map((step) => (
            <CallRow key={step.id} call={step} />
          ))}
          {call.output !== undefined && <pre className="call-output">{call.output}</pre>}
        </div>
      ) : (
        <>
          <pre className="call-input">
            {call.tool === "Bash" ? `$ ${call.input}` : `${call.tool} ${call.input}`}
          </pre>
          {call.output === undefined ? (
            <p className="dim">Running…</p>
          ) : call.output.trim() ? (
            <pre className="call-output">{call.output}</pre>
          ) : (
            <p className="dim">No output.</p>
          )}
        </>
      )}
    </details>
  );
}
