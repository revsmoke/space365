/**
 * P4 surface: Planner tasks → personal quests.
 *
 * Teams are M365 groups, so for each synced team id: /groups/{id}/planner/plans,
 * then /planner/plans/{id}/tasks. Every incomplete task (percentComplete < 100)
 * with assignments becomes one quest per assigned user
 * (questId 'planner-<taskId>-<userId>'). The task title IS personal data —
 * that's allowed here because the module shows quests only to their owner and
 * silently drops writes for users without opt_in_personal=true (server-enforced).
 */
import { GraphError } from "../graph_client";
import { stdbSql } from "../stdb_sql";
import {
  type GraphLike,
  type SurfaceReducers,
  type SurfaceRunOptions,
} from "./common";

export const PLANNER_INTERVAL_MS = 10 * 60_000;

export type PlannerPlan = { id?: string; title?: string };

export type PlannerTask = {
  id?: string;
  title?: string;
  percentComplete?: number;
  assignments?: Record<string, unknown> | null;
};

export type QuestRow = {
  questId: string;
  userId: string;
  kind: string;
  title: string;
  sourceRef: string;
  deeplink: string;
  status: string;
};

export function plannerDeeplink(taskId: string): string {
  return `https://tasks.office.com/Home/Task/${taskId}`;
}

/** One quest per assigned user; completed or unassigned tasks yield none. */
export function taskToQuests(task: PlannerTask, planTitle: string): QuestRow[] {
  if (!task.id || (task.percentComplete ?? 0) >= 100) return [];
  return Object.keys(task.assignments ?? {}).map((userId) => ({
    questId: `planner-${task.id}-${userId}`,
    userId,
    kind: "task",
    title: task.title ?? "",
    sourceRef: planTitle,
    deeplink: plannerDeeplink(task.id!),
    status: "open",
  }));
}

export type PlannerResult = {
  teamsPolled: number;
  teamsSkipped: number;
  plans: number;
  tasksSeen: number;
  questsWritten: number;
};

export async function runPlannerQuestsOnce(
  graph: GraphLike,
  reducers: Pick<SurfaceReducers, "createOrUpdateQuest">,
  options: SurfaceRunOptions = {},
): Promise<PlannerResult> {
  const log = options.log ?? console.log;
  const sql = options.sql ?? stdbSql;

  const teamIds = (await sql("SELECT team_id FROM team WHERE is_enabled = true"))
    .map((row) => row[0])
    .filter(Boolean);

  const result: PlannerResult = {
    teamsPolled: 0,
    teamsSkipped: 0,
    plans: 0,
    tasksSeen: 0,
    questsWritten: 0,
  };

  for (const teamId of teamIds) {
    let plans: PlannerPlan[];
    try {
      plans = (await graph.getAll(`/groups/${teamId}/planner/plans`)) as PlannerPlan[];
    } catch (error) {
      // 400: non-GUID dev seed ids; 403/404: no group / license / access.
      if (
        error instanceof GraphError &&
        (error.status === 400 || error.status === 403 || error.status === 404)
      ) {
        result.teamsSkipped++;
        log(`planner.skip team=${teamId} status=${error.status} code=${error.code}`);
        continue;
      }
      throw error;
    }
    result.teamsPolled++;
    result.plans += plans.length;

    for (const plan of plans) {
      if (!plan.id) continue;
      const tasks = (await graph.getAll(
        `/planner/plans/${plan.id}/tasks`,
      )) as PlannerTask[];
      result.tasksSeen += tasks.length;
      for (const task of tasks) {
        for (const quest of taskToQuests(task, plan.title ?? "")) {
          // Server drops this silently unless the user opted in — correct.
          if (!options.dryRun) await reducers.createOrUpdateQuest(quest);
          result.questsWritten++;
        }
      }
    }
  }

  log(
    `planner.done teams=${result.teamsPolled} skipped=${result.teamsSkipped} ` +
      `plans=${result.plans} tasks=${result.tasksSeen} quests=${result.questsWritten}` +
      (options.dryRun ? " dry_run=1" : ""),
  );
  return result;
}
