// Exercise the site against two compiled programs. Never fetch or install a program for this check.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const programs = process.argv.slice(2);
if (programs.length !== 2) throw new Error("Pass the program without Decisions, then the program with Decisions.");
const cwd = fileURLToPath(new URL("./", import.meta.url));
for (const [index, path] of programs.entries()) {
  const bin = resolve(path);
  const info = JSON.parse(execFileSync(bin,["describe","--json"],{encoding:"utf8",maxBuffer:8 * 1024 * 1024}));
  const operations = info.operations.map(op => op.name);
  for (const name of ["create_decision","update_decision","list_decisions"]) {
    if (operations.includes(name) !== (index === 1)) throw new Error(`Unexpected operation catalog for program ${index+1}: ${name}`);
  }
  execFileSync(process.execPath,["--test","*.test.mjs"],{cwd,env:{...process.env,VIGILE_BIN:bin},stdio:"inherit"});
}
