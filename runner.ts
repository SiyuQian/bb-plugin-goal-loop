import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface WorkflowCliContext {
  threadId: string;
  projectId: string;
  serverUrl: string;
  dataDir: string;
  signal?: AbortSignal;
}

export interface WorkflowStatus {
  id: string;
  status: string;
  resultAvailable?: boolean;
  result?: unknown;
  error?: string | null;
  [key: string]: unknown;
}

type WorkflowTarget = WorkflowCliContext & { runId: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(operation: string): Error {
  return new Error(`Workflow CLI ${operation} returned an invalid response.`);
}

async function command(
  operation: "run" | "status" | "stop",
  args: string[],
  context: WorkflowCliContext,
): Promise<unknown> {
  if (context.signal?.aborted) {
    const error = new Error(`Workflow CLI ${operation} aborted.`);
    error.name = "AbortError";
    throw error;
  }
  let stdout: string;
  try {
    ({ stdout } = await execute(process.env.BB_CLI?.trim() || "bb", [
      "workflows", operation, ...args, "--json",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        BB_THREAD_ID: context.threadId,
        BB_PROJECT_ID: context.projectId,
        BB_SERVER_URL: context.serverUrl,
        BB_DATA_DIR: context.dataDir,
      },
      signal: context.signal,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }));
  } catch (cause) {
    // execFile errors contain the whole command, including private task text.
    const code = object(cause) ? cause.code : undefined;
    const error = new Error(`Workflow CLI ${operation} failed${
      typeof code === "number" ? ` with exit code ${code}` : ""
    }.`);
    if (context.signal?.aborted) error.name = "AbortError";
    throw error;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw invalid(operation);
  }
}

export async function startWorkflow(
  options: WorkflowCliContext & { source: string; args: unknown },
): Promise<{ runId: string }> {
  const result = await command("run", [
    "--script", options.source, "--args", JSON.stringify(options.args),
  ], options);
  if (!object(result) || typeof result.runId !== "string" || !result.runId.trim()) {
    throw invalid("run");
  }
  return { runId: result.runId };
}

export async function workflowStatus(options: WorkflowTarget): Promise<WorkflowStatus> {
  const result = await command("status", [options.runId], options);
  if (!object(result) || result.id !== options.runId ||
      typeof result.status !== "string" || !result.status.trim()) {
    throw invalid("status");
  }
  return result as WorkflowStatus;
}

export async function stopWorkflow(
  options: WorkflowTarget,
): Promise<{ runId: string; stopped: boolean }> {
  const result = await command("stop", [options.runId], options);
  if (!object(result) || result.runId !== options.runId || typeof result.stopped !== "boolean") {
    throw invalid("stop");
  }
  return { runId: result.runId as string, stopped: result.stopped };
}
