# jj orbit (vendored)

The files jj orbit 0.32.2 needs at run time (server, exporter, built viewer and the browser libraries), copied
unchanged from the snapshot of 2026-10-22. fleet starts `jj_orbit_server.py` on a free port on 127.0.0.1 and serves
it under `/orbit/` as the history view.

`SOURCE.json` has a hash per file, and fleet's tests fail when a file differs. To update, copy a newer release over
these files and write new hashes; do not edit them here.
