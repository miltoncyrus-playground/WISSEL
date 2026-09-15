#!/usr/bin/env bun
import { Registry } from "./core/registry.ts";
import { Router } from "./core/router.ts";

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "agents": {
    const registry = await Registry.load();
    for (const agent of registry.all()) {
      console.log(`${agent.id.padEnd(20)} ${agent.tier.padEnd(9)} ${agent.tags.join(", ")}`);
    }
    break;
  }
  case "route": {
    // wissel route --explain <task-id>
    void new Router(await Registry.load());
    console.log("not implemented:", args.join(" "));
    break;
  }
  default:
    console.log("usage: wissel <agents|route>");
    process.exit(1);
}
