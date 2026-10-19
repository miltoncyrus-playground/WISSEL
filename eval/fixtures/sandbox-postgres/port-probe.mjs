// Is anything listening on 127.0.0.1:<port> in this Bash call's network
// namespace? Prints PORT_<port>=open or PORT_<port>=closed (<errno>).
// Run after pg-check.sh in a new Bash call, it shows the server started
// there did not outlive its call (docs/SDD-sandboxed-postgres.md).
//
//   bun run port-probe.mjs <port>
import { connect } from "node:net";

const port = Number(process.argv[2] ?? 54329);
const sock = connect({ host: "127.0.0.1", port });
sock.setTimeout(3000);
sock.once("connect", () => {
  console.log(`PORT_${port}=open`);
  sock.destroy();
});
sock.once("timeout", () => {
  console.log(`PORT_${port}=closed (timeout)`);
  sock.destroy();
});
sock.once("error", (e) => console.log(`PORT_${port}=closed (${e.code ?? e.message})`));
