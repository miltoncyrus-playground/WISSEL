// Can a sandboxed process bind a Unix domain socket? Prints one line,
// UNIX_SOCKET_BIND=ok or UNIX_SOCKET_BIND=refused (<detail>). Inside the
// write-tier sandbox the seccomp filter answers EPERM; Bun's node:net
// reports that without an errno ("Failed to listen at <path>"), so the
// live check asserts on refused/ok and takes the errno from Postgres's
// own log in pg-check.sh's unixdir mode ("Operation not permitted").
//
//   bun run unix-probe.mjs <writable-dir>
import { unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const dir = process.argv[2] || "/tmp";
const path = join(dir, `wissel-unix-probe-${process.pid}.sock`);
const srv = createServer();
srv.once("error", (e) => {
  console.log(`UNIX_SOCKET_BIND=refused (${e.code ?? e.message})`);
  process.exit(0);
});
srv.listen(path, () => {
  console.log("UNIX_SOCKET_BIND=ok");
  srv.close();
  try {
    unlinkSync(path);
  } catch {}
});
