import { type FormEvent, useState } from "react";

/**
 * Submits a form by a request to the daemon, without reloading the page. While the request is
 * pending, further submits are ignored; a failed one leaves its message in `error` until the next.
 */
export function useSubmit<T>(
  request: () => Promise<T>,
  onDone: (result: T) => void,
): { submit: (event: FormEvent) => void; pending: boolean; error?: string } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    request()
      .then(onDone, (e: Error) => setError(e.message))
      .finally(() => setPending(false));
  };

  return { submit, pending, error };
}
