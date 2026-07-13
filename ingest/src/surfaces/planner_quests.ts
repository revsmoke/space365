/**
 * P4 surface: Planner tasks → personal quests + team-visible zone task boards.
 *
 * Teams are M365 groups, so for each synced team id: /groups/{id}/planner/plans,
 * then /planner/plans/{id}/tasks (and /buckets once per plan for bucket names).
 *
 * Personal quests: every incomplete task (percentComplete < 100) with
 * assignments becomes one quest per assigned user
 * (questId 'planner-<taskId>-<userId>'). The task title IS personal data —
 * that's allowed here because the module shows quests only to their owner and
 * silently drops writes for users without opt_in_personal=true (server-enforced).
 *
 * Zone tasks: EVERY task (completed included — clients style them) is
 * upserted to zone_task with teamId = the group id. Tasks that vanish from a
 * successfully-polled team's plans since the last sync are deleted; teams
 * that were skipped (400/403/404) keep their rows untouched.
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

export type PlannerBucket = { id?: string; name?: string };

export type PlannerTask = {
  id?: string;
  title?: string;
  percentComplete?: number;
  bucketId?: string | null;
  dueDateTime?: string | null;
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

export type ZoneTaskRow = {
  taskId: string;
  teamId: string;
  planTitle: string;
  title: string;
  bucket: string;
  percentComplete: number;
  due: string | undefined;
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

/** bucketId → display name from a plan's /buckets listing. */
export function bucketNameMap(buckets: PlannerBucket[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const bucket of buckets) {
    if (bucket.id) byId.set(bucket.id, bucket.name ?? "");
  }
  return byId;
}

/** Date part of a Planner dueDateTime (ISO), or undefined when absent. */
export function dueDatePart(
  dueDateTime: string | null | undefined,
): string | undefined {
  if (!dueDateTime) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(dueDateTime);
  return match ? match[1] : undefined;
}

/**
 * Task → team-visible zone task row. Completed tasks (percentComplete 100)
 * map too — clients style them, we never drop them here. Unknown/missing
 * bucket ids fall back to ''.
 */
export function taskToZoneTask(
  task: PlannerTask,
  teamId: string,
  planTitle: string,
  bucketsById: Map<string, string>,
): ZoneTaskRow | null {
  if (!task.id) return null;
  return {
    taskId: task.id,
    teamId,
    planTitle,
    title: task.title ?? "",
    bucket: (task.bucketId && bucketsById.get(task.bucketId)) || "",
    percentComplete: task.percentComplete ?? 0,
    due: dueDatePart(task.dueDateTime),
  };
}

/**
 * Which previously-synced task ids vanished. Only tasks belonging to teams we
 * successfully polled this run count — a skipped/failed team must not have
 * its board wiped.
 */
export function detectVanishedTasks(
  known: Iterable<readonly [taskId: string, teamId: string]>,
  seenTaskIds: Set<string>,
  polledTeams: Set<string>,
): string[] {
  const vanished: string[] = [];
  for (const [taskId, teamId] of known) {
    if (!polledTeams.has(teamId)) continue;
    if (!seenTaskIds.has(taskId)) vanished.push(taskId);
  }
  return vanished;
}

export type PlannerResult = {
  teamsPolled: number;
  teamsSkipped: number;
  plans: number;
  tasksSeen: number;
  questsWritten: number;
  zoneTasksWritten: number;
  zoneTasksDeleted: number;
};

export async function runPlannerQuestsOnce(
  graph: GraphLike,
  reducers: Pick<
    SurfaceReducers,
    "createOrUpdateQuest" | "upsertZoneTask" | "deleteZoneTask"
  >,
  options: SurfaceRunOptions = {},
): Promise<PlannerResult> {
  const log = options.log ?? console.log;
  const sql = options.sql ?? stdbSql;

  const teamIds = (await sql("SELECT team_id FROM team WHERE is_enabled = true"))
    .map((row) => row[0])
    .filter(Boolean);

  // Cursor of previously-synced zone tasks, for delete detection.
  const knownZoneTasks: [string, string][] = (
    await sql("SELECT task_id, team_id FROM zone_task")
  )
    .filter((row) => row[0])
    .map((row) => [row[0], row[1] ?? ""] as [string, string]);

  const result: PlannerResult = {
    teamsPolled: 0,
    teamsSkipped: 0,
    plans: 0,
    tasksSeen: 0,
    questsWritten: 0,
    zoneTasksWritten: 0,
    zoneTasksDeleted: 0,
  };

  const polledTeams = new Set<string>();
  const seenTaskIds = new Set<string>();

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
    polledTeams.add(teamId);
    result.plans += plans.length;

    for (const plan of plans) {
      if (!plan.id) continue;

      // Bucket names, once per plan; a failed read degrades to '' buckets.
      let bucketsById = new Map<string, string>();
      try {
        bucketsById = bucketNameMap(
          (await graph.getAll(`/planner/plans/${plan.id}/buckets`)) as PlannerBucket[],
        );
      } catch (error) {
        if (!(error instanceof GraphError)) throw error;
        log(`planner.buckets.skip plan=${plan.id} status=${error.status}`);
      }

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
        const zoneTask = taskToZoneTask(task, teamId, plan.title ?? "", bucketsById);
        if (zoneTask) {
          seenTaskIds.add(zoneTask.taskId);
          if (!options.dryRun) await reducers.upsertZoneTask(zoneTask);
          result.zoneTasksWritten++;
        }
      }
    }
  }

  for (const taskId of detectVanishedTasks(knownZoneTasks, seenTaskIds, polledTeams)) {
    if (!options.dryRun) await reducers.deleteZoneTask({ taskId });
    result.zoneTasksDeleted++;
  }

  log(
    `planner.done teams=${result.teamsPolled} skipped=${result.teamsSkipped} ` +
      `plans=${result.plans} tasks=${result.tasksSeen} quests=${result.questsWritten} ` +
      `zone_tasks=${result.zoneTasksWritten} zone_deleted=${result.zoneTasksDeleted}` +
      (options.dryRun ? " dry_run=1" : ""),
  );
  return result;
}
