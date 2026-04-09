#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { Command } from 'commander';

interface LogEvent {
  line_no: number;
  timestamp: Date | null;
  session_id: string | null;
  type: string;
  summary: string;
  tool?: string;
  input?: any;
  output?: any;
  raw: any;
}

interface Run {
  session_id: string | null;
  events: LogEvent[];
  max_line: number;
}

interface SessionListing {
  path?: string | null;
  stores?: Array<{ agentId?: string; path?: string | null }>;
  sessions?: Array<{ sessionId?: string; sessionFile?: string; updatedAt?: number; agentId?: string }>;
}

const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/;
const SUMMARY_PREVIEW = 100;
const DETAIL_PREVIEW = 2000;
const SUGGESTIONS: Record<string, string[]> = {
  tool_loop: ["Avoid repeating identical tool calls.", "Limit retries to 2.", "Add state tracking to detect duplicate tool inputs."],
  no_output: ["Ensure the agent produces a final response.", "Check termination conditions.", "Verify output is not overwritten by later steps."],
  error: ["Inspect tool or model errors in the logs.", "Validate tool inputs before calling them.", "Add error handling or controlled retries."],
  no_model_step: ["Ensure the model is invoked after user input.", "Check routing or planning logic before tool execution."],
};

function listSessionFiles(sessionDir: string): string[] {
  if (!fs.existsSync(sessionDir)) return [];
  return fs
    .readdirSync(sessionDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(sessionDir, f));
}

function pickLatestFile(files: string[]): string | null {
  if (!files.length) return null;
  return files.sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime())[0] || null;
}

function getOpenClawSessionListing(agent?: string): SessionListing | null {
  const args = ['sessions'];
  if (agent) args.push('--agent', agent);
  args.push('--json');

  const result = spawnSync('openclaw', args, { encoding: 'utf-8' });
  if (result.status !== 0 || !result.stdout.trim()) return null;

  try {
    return JSON.parse(result.stdout) as SessionListing;
  } catch {
    return null;
  }
}

function resolveSessionDirFromListing(listing: SessionListing, agent?: string): string | null {
  if (listing.path) return path.dirname(listing.path);
  if (agent && listing.stores?.length) {
    const store = listing.stores.find(s => s.agentId === agent && s.path);
    if (store?.path) return path.dirname(store.path);
  }
  return null;
}

function resolveSessionFileFromListing(listing: SessionListing): string | null {
  const sessions = [...(listing.sessions || [])];
  if (!sessions.length) return null;

  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const latest = sessions[0];
  if (!latest) return null;
  if (latest.sessionFile) return latest.sessionFile;

  const sessionDir = resolveSessionDirFromListing(listing, latest.agentId);
  if (!sessionDir || !latest.sessionId) return null;

  return path.join(sessionDir, `${latest.sessionId}.jsonl`);
}

function resolveDefaultSessionFile(agent?: string, sessionDir?: string): string | null {
  if (sessionDir) {
    return pickLatestFile(listSessionFiles(sessionDir));
  }

  const listing = getOpenClawSessionListing(agent);
  const fromListing = listing ? resolveSessionFileFromListing(listing) : null;
  if (fromListing && fs.existsSync(fromListing)) return fromListing;

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const fallbackDir = agent
    ? path.join(home, '.openclaw', 'agents', agent, 'sessions')
    : path.join(home, '.openclaw', 'agents', 'main', 'sessions');

  return pickLatestFile(listSessionFiles(fallbackDir));
}

function parseTimestamp(line: any): Date | null {
  if (typeof line === 'object' && line !== null) {
    for (const key of ["time", "timestamp", "ts", "created_at"]) {
      if (line[key]) {
        const d = new Date(line[key]);
        if (!isNaN(d.getTime())) return d;
      }
    }
  }
  const match = String(line).match(ISO_TS_RE);
  if (match) {
    const d = new Date(match[0]);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function stringifyValue(value: any): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewValue(value: any, maxChars: number): string {
  const text = stringifyValue(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function parseRawEventSelection(value?: string): number[] {
  if (!value) return [];

  return value
    .split(',')
    .map(part => parseInt(part.trim(), 10))
    .filter(n => Number.isInteger(n) && n > 0);
}

function extractSessionId(line: any): string | null {
  if (typeof line === 'object' && line !== null) {
    for (const key of ["runId", "run_id", "sessionId", "session_id", "session"]) {
      if (line[key]) return String(line[key]);
    }
    if (line._meta) {
      for (const key of ["runId", "run_id", "sessionId", "session_id"]) {
        if (line._meta[key]) return String(line._meta[key]);
      }
    }
    if (line.data && typeof line.data === 'object') {
      for (const key of ["runId", "run_id", "sessionId", "session_id"]) {
        if (line.data[key]) return String(line.data[key]);
      }
    }
    for (const argKey of ["0", "1"]) {
      const arg = String(line[argKey] || "");
      const match = arg.match(/runId["': ]+([A-Za-z0-9._-]+)/);
      if (match) return match[1];
    }
  }
  return null;
}

function classifyEvent(line: any): string {
  const text = JSON.stringify(line).toLowerCase();
  
  if (!text.includes("error") && !text.includes("failed")) {
    const noiseMarkers = [
        "heartbeat", "websocket", "ws connected", "ws disconnected", 
        "res ✓", "plugins", "starting provider", "canvas host mounted",
        "device pairing auto-approved", "watchdog detected", "ready (", "log file:",
        "node.list", "models.list", "chat.history", "status", "cron.list", "sessions.usage",
        "openclaw:bootstrap-context"
    ];
    if (noiseMarkers.some(m => text.includes(m))) {
      const behavioralIndicators = ["toolcall", "toolresult", "role\": \"user", "final response"];
      if (!behavioralIndicators.some(b => text.includes(b))) return "noise";
    }
  }

  if (typeof line === 'object' && line !== null) {
    if (line.role === "user") return "user";
    if (line.role === "toolResult") return "tool_result";
  }

  if (text.includes("error") || text.includes("exception") || text.includes("traceback") || text.includes("failed")) return "error";
  if (text.includes("tool result") || text.includes("function result") || (text.includes("tool") && text.includes("output"))) return "tool_result";
  if (text.includes("calling tool") || text.includes("tool call") || (text.includes("tool") && text.includes("input"))) return "tool_call";
  if (text.includes("sent response") || text.includes("final response") || text.includes("reply sent")) return "final_output";
  if (text.includes("completion") || text.includes("model") || text.includes("llm step")) return "llm";
  if (text.includes("\"role\": \"user\"") || text.includes("received message")) return "user";

  return "other";
}

function extractSummary(line: any, eventType: string): string {
  if (typeof line === 'object' && line !== null) {
    const msg = String(line.message || "");
    const content = String(line.content || "");
    const tool = line.tool || line.toolName || line.name || "unknown";
    const arg0 = String(line["0"] || "");
    const arg1 = String(line["1"] || "");

    if (eventType === "tool_call") {
      const inp = line.input || line.arguments || line.args || line["0"];
      return `Tool call: ${tool} | input=${previewValue(inp || "", SUMMARY_PREVIEW)}`;
    }
    if (eventType === "tool_result") {
      const res = line.output || line.result || line["1"];
      return `Tool result: ${tool} | output=${previewValue(res || "", SUMMARY_PREVIEW)}`;
    }
    if (eventType === "llm") return line.model ? `LLM call: ${line.model}` : (msg || content.slice(0, 120) || "LLM step");
    if (eventType === "error") {
      const err = line.error || line.cause || line["0"] || msg || content;
      return `ERROR: ${String(err).slice(0, 120)}`;
    }
    if (eventType === "user") {
      if (arg0.startsWith('{')) {
        try {
          const p = JSON.parse(arg0);
          if (p.subsystem) return `System (${p.subsystem}): ${arg1.slice(0, 120)}`;
        } catch {}
      }
      return `User: ${previewValue(content || msg || arg0 || line, 120)}`;
    }
    if (eventType === "final_output") return `Final output: ${previewValue(content || msg || arg1 || "response sent", 120)}`;
  }
  return String(line).slice(0, 120);
}

function parseLines(rawLines: string[]): any[] {
  return rawLines.map((raw, idx) => {
    if (!raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'message' && parsed.message) {
        const msg = parsed.message;
        const pseudo: any = {
          time: parsed.timestamp,
          runId: parsed.runId,
          sessionId: parsed.sessionId,
          role: msg.role,
          data: parsed.data
        };
        if (msg.role === 'assistant') {
          const content = msg.content;
          const call = Array.isArray(content) ? content.find((c: any) => c.type === 'toolCall') : null;
          if (call) {
            pseudo.type = 'tool_call';
            pseudo.tool = call.name;
            pseudo.input = call.arguments;
          } else {
            pseudo.type = 'llm';
            pseudo.content = Array.isArray(content) ? content.find((c: any) => c.type === 'text')?.text : content;
          }
        } else if (msg.role === 'toolResult') {
          pseudo.type = 'tool_result';
          pseudo.tool = msg.toolName;
          pseudo.output = msg.content;
        } else if (msg.role === 'user') {
          const content = msg.content;
          pseudo.type = 'user';
          pseudo.content = Array.isArray(content) ? content.find((c: any) => c.type === 'text')?.text : content;
        }
        return { _line_no: idx + 1, _raw: raw, _parsed: pseudo };
      }
      return { _line_no: idx + 1, _raw: raw, _parsed: parsed };
    } catch {
      if (raw.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
        const parts = raw.split(" ", 4);
        if (parts.length >= 4) {
          return { _line_no: idx + 1, _raw: raw, _parsed: { time: parts[0], level: parts[1], subsystem: parts[2].replace(/[\[\]]/g, ''), "0": raw.split(" ").slice(4).join(" ") } };
        }
      }
      return { _line_no: idx + 1, _raw: raw, _parsed: raw };
    }
  }).filter(l => l !== null);
}

function buildEvents(parsedLines: any[]): LogEvent[] {
  return parsedLines.map(item => {
    const obj = item._parsed;
    const type = classifyEvent(obj);
    return {
      line_no: item._line_no,
      timestamp: parseTimestamp(obj),
      session_id: extractSessionId(obj),
      type,
      summary: extractSummary(obj, type),
      tool: obj.tool,
      input: obj.input,
      output: obj.output,
      raw: obj
    };
  }).filter(e => e.type !== 'noise');
}

function splitRuns(events: LogEvent[], gapSeconds = 60): Run[] {
  const bySession: Record<string, LogEvent[]> = {};
  const noSession: LogEvent[] = [];

  for (const e of events) {
    if (e.session_id) {
      if (!bySession[e.session_id]) bySession[e.session_id] = [];
      bySession[e.session_id].push(e);
    } else {
      noSession.push(e);
    }
  }

  const runs: Run[] = Object.entries(bySession).map(([sid, evs]) => ({
    session_id: sid,
    events: evs.sort((a, b) => a.line_no - b.line_no),
    max_line: Math.max(...evs.map(e => e.line_no))
  }));

  if (noSession.length) {
    noSession.sort((a, b) => a.line_no - b.line_no);
    let current: LogEvent[] = [];
    for (const e of noSession) {
      if (current.length && e.timestamp && current[current.length - 1].timestamp) {
        const gap = (e.timestamp.getTime() - current[current.length - 1].timestamp!.getTime()) / 1000;
        if (gap > gapSeconds) {
          runs.push({ session_id: 'other/system', events: current, max_line: Math.max(...current.map(ev => ev.line_no)) });
          current = [];
        }
      }
      current.push(e);
    }
    if (current.length) runs.push({ session_id: 'other/system', events: current, max_line: Math.max(...current.map(ev => ev.line_no)) });
  }

  return runs.sort((a, b) => a.max_line - b.max_line);
}

function detectFailure(run: Run): string {
  const types = run.events.map(e => e.type);
  if (types.includes('error')) return 'error';
  const tcalls = run.events.filter(e => e.type === 'tool_call').map(e => e.tool || e.summary);
  if (tcalls.length >= 3 && new Set(tcalls.slice(-3)).size === 1) return 'tool_loop';
  if (types.includes('user') && types.includes('llm') && !types.includes('final_output')) return 'no_output';
  if (types.includes('user') && !types.includes('llm') && !run.events.some(e => e.type === 'other')) return 'no_model_step';
  return 'ok';
}

function printRawEvents(run: Run, rawEventNumbers: number[]) {
  const selected = rawEventNumbers
    .map(n => ({ eventNumber: n, event: run.events[n - 1] }))
    .filter(item => item.event);

  if (!selected.length) return;

  console.log("\nRaw events:");
  selected.forEach(({ eventNumber, event }) => {
    console.log(`\n--- Event ${eventNumber} (line ${event!.line_no}) ---`);
    console.log(stringifyValue(event!.raw));
  });
}

function printRun(run: Run, idx: number, verbose: boolean, rawEventNumbers: number[]) {
  const start = run.events[0].timestamp;
  const end = run.events[run.events.length - 1].timestamp;
  const duration = (start && end) ? `${((end.getTime() - start.getTime()) / 1000).toFixed(1)}s` : '';
  
  console.log(`\n=== Run #${idx} | session=${run.session_id || 'no-session'} (${duration}) ===`);
  run.events.forEach((e, i) => {
    const ts = e.timestamp ? e.timestamp.toISOString().split('T')[1].split('.')[0] : '??:??:??';
    console.log(`${String(i + 1).padStart(2, '0')}. [${ts}] line=${e.line_no} ${e.summary}`);
    if (verbose) {
      if (e.type === 'tool_call') {
        console.log(`    👉 Input:\n${previewValue(e.input || "", DETAIL_PREVIEW)}`);
      }
      if (e.type === 'tool_result') {
        console.log(`    👈 Output:\n${previewValue(e.output || "", DETAIL_PREVIEW)}`);
      }
    }
  });

  const ftype = detectFailure(run);
  console.log(`\nStatus: ${ftype}`);
  if (SUGGESTIONS[ftype]) {
    console.log("\nSuggestions:");
    SUGGESTIONS[ftype].forEach(s => console.log(`- ${s}`));
  }

  printRawEvents(run, rawEventNumbers);
}

async function main() {
  const program = new Command('condenclaw');
  program
    .description('Condense OpenClaw session transcripts into a layered debugging view.')
    .argument('[file]', 'Log file path')
    .option('--json', 'Output JSON')
    .option('--limit <n>', 'Limit total runs (e.g., -1 for latest)', (v: string) => parseInt(v))
    .option('--agent <id>', 'Read sessions for a specific OpenClaw agent')
    .option('--session-dir <path>', 'Directory containing OpenClaw session JSONL files')
    .option('--session <path>', 'Specific session file')
    .option('--raw-event <numbers>', 'Show exact raw payloads for specific event numbers, e.g. 3 or 3,7')
    .option('-v, --verbose', 'Verbose tool data')
    .helpOption('-h, --help', 'List commands, flags, and usage examples')
    .addHelpText('after', `
Examples:
  $ condenclaw --limit -1
  $ condenclaw --agent worker --limit -1 -v
  $ condenclaw --session ~/.openclaw/agents/main/sessions/<session>.jsonl --raw-event 3,7
  $ condenclaw --limit -1 --json
`)
    .parse(process.argv);

  const options = program.opts();
  let targetFile: string | null | undefined = program.args[0];
  let inputLines: string[] = [];

  if (options.session) targetFile = options.session;
  if (!targetFile) {
    targetFile = resolveDefaultSessionFile(options.agent, options.sessionDir);
  }
  if (!targetFile) {
    console.error('No OpenClaw session file found. Use --agent, --session-dir, or --session to target a transcript explicitly.');
    process.exit(1);
  }
  const resolvedTargetFile = targetFile;
  if (fs.existsSync(resolvedTargetFile)) {
    inputLines = fs.readFileSync(resolvedTargetFile, 'utf-8').split('\n');
  } else {
    console.error(`File not found: ${resolvedTargetFile}`);
    process.exit(1);
  }

  const events = buildEvents(parseLines(inputLines));
  const allRuns = splitRuns(events);
  let displayRuns = allRuns;
  const rawEventNumbers = parseRawEventSelection(options.rawEvent);

  if (options.limit !== undefined) {
    const limit = options.limit;
    if (limit < 0) {
      displayRuns = allRuns.slice(limit);
    } else if (limit > 0) {
      displayRuns = allRuns.slice(0, limit);
    }
  }

  if (options.json) {
    const out = displayRuns.map(r => ({
      run_number: allRuns.indexOf(r) + 1,
      session_id: r.session_id,
      failure_type: detectFailure(r),
      suggestions: SUGGESTIONS[detectFailure(r)] || [],
      events: r.events.map((e, i) => ({
        event_number: i + 1,
        line_no: e.line_no,
        timestamp: e.timestamp,
        type: e.type,
        summary: e.summary,
        detail: options.verbose ? {
          tool: e.tool,
          input: e.input,
          output: e.output
        } : undefined,
        raw: rawEventNumbers.includes(i + 1) ? e.raw : undefined
      }))
    }));
    console.log(JSON.stringify({ runs: out }, null, 2));
  } else {
    displayRuns.forEach(r => printRun(r, allRuns.indexOf(r) + 1, !!options.verbose, rawEventNumbers));
  }
}

main();
